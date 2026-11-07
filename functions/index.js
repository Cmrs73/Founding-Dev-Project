const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Set with: firebase functions:secrets:set NAME
const CONSUMER_KEY = defineSecret('DARAJA_CONSUMER_KEY');
const CONSUMER_SECRET = defineSecret('DARAJA_CONSUMER_SECRET');
const PASSKEY = defineSecret('DARAJA_PASSKEY');
const CALLBACK_TOKEN = defineSecret('DARAJA_CALLBACK_TOKEN');
// Paystack dashboard > Settings > API Keys & Webhooks. Use sk_test_... until you go live.
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');

// Override in functions/.env. The defaults are Safaricom's public sandbox values.
const DARAJA_ENV = defineString('DARAJA_ENV', { default: 'sandbox' });
const SHORTCODE = defineString('DARAJA_SHORTCODE', { default: '174379' });

const REGION = 'us-central1';

// The amount charged is always taken from here, never from the browser.
// Keep in step with the amounts shown in js/payments.js.
const PLAN_PRICES_KES = { unlock: 2500, unleash: 7700 };

const RATE_LIMIT_MS = 60 * 1000;
const PAYSTACK_RATE_LIMIT_MS = 10 * 1000;
const PAYSTACK_API = 'https://api.paystack.co';

// The browser picks a method; the server decides which Paystack channels that allows.
const PAYSTACK_CHANNELS = {
    visa: ['card'],
    airtel: ['mobile_money'],
};

function darajaBaseUrl() {
    return DARAJA_ENV.value() === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
}

// Daraja expects the timestamp in Kenyan time, as yyyyMMddHHmmss.
function darajaTimestamp(date = new Date()) {
    const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    return eat.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Accepts 0712345678, 712345678, 254712345678 and +254712345678.
function normalizePhone(input) {
    const match = /^(?:\+?254|0)?([17]\d{8})$/.exec(String(input || '').replace(/[\s-]/g, ''));
    return match ? `254${match[1]}` : null;
}

async function getAccessToken() {
    const credentials = Buffer.from(`${CONSUMER_KEY.value()}:${CONSUMER_SECRET.value()}`).toString('base64');
    const response = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${credentials}` },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Daraja auth failed with status ${response.status}`);
    const body = await response.json();
    return body.access_token;
}

async function requestStkPush({ phone, amount, plan }) {
    const shortcode = SHORTCODE.value();
    const timestamp = darajaTimestamp();
    const token = await getAccessToken();
    const callbackUrl = `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/paymentCallback`
        + `?token=${encodeURIComponent(CALLBACK_TOKEN.value())}`;

    const response = await fetch(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: Buffer.from(`${shortcode}${PASSKEY.value()}${timestamp}`).toString('base64'),
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount,
            PartyA: phone,
            PartyB: shortcode,
            PhoneNumber: phone,
            CallBackURL: callbackUrl,
            AccountReference: 'FoundingDev',
            TransactionDesc: `${plan} plan`.slice(0, 13),
        }),
        signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (!response.ok || body.ResponseCode !== '0') {
        throw new Error(`STK push rejected: ${body.errorMessage || body.ResponseDescription || response.status}`);
    }
    return body;
}

// Each push rings someone's phone, so one account cannot send them back to back.
async function claimRateLimit(uid, kind = 'mpesa', limitMs = RATE_LIMIT_MS) {
    const ref = db.collection('paymentLimits').doc(kind === 'mpesa' ? uid : `${uid}_${kind}`);
    return db.runTransaction(async function (transaction) {
        const snapshot = await transaction.get(ref);
        const last = snapshot.exists ? snapshot.get('lastAt').toMillis() : 0;
        if (Date.now() - last < limitMs) return false;
        transaction.set(ref, { lastAt: FieldValue.serverTimestamp() });
        return true;
    });
}

exports.startMpesaPayment = onCall(
    { region: REGION, secrets: [CONSUMER_KEY, CONSUMER_SECRET, PASSKEY, CALLBACK_TOKEN] },
    async function (request) {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Please log in to pay.');
        }
        const plan = request.data && request.data.plan;
        if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES_KES, plan)) {
            throw new HttpsError('invalid-argument', 'That plan cannot be paid for with M-Pesa.');
        }
        const phone = normalizePhone(request.data.phone);
        if (!phone) {
            throw new HttpsError('invalid-argument', 'Please enter a valid Safaricom number, like 0712 345 678.');
        }
        if (!(await claimRateLimit(request.auth.uid))) {
            throw new HttpsError('resource-exhausted', 'Please wait a minute before trying again.');
        }

        const amount = PLAN_PRICES_KES[plan];
        let stk;
        try {
            stk = await requestStkPush({ phone, amount, plan });
        } catch (error) {
            logger.error('STK push failed', error);
            throw new HttpsError('unavailable', 'M-Pesa could not be reached. Please try again in a minute.');
        }

        await db.collection('payments').doc(stk.CheckoutRequestID).set({
            uid: request.auth.uid,
            plan,
            amount,
            currency: 'KES',
            method: 'mpesa',
            phone,
            status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
        });
        return { paymentId: stk.CheckoutRequestID };
    },
);

// Safaricom calls this once the customer accepts, declines or ignores the prompt.
exports.paymentCallback = onRequest(
    { region: REGION, secrets: [CALLBACK_TOKEN] },
    async function (request, response) {
        if (request.method !== 'POST' || request.query.token !== CALLBACK_TOKEN.value()) {
            response.status(403).send('Forbidden');
            return;
        }

        const callback = request.body && request.body.Body && request.body.Body.stkCallback;
        if (!callback || !callback.CheckoutRequestID) {
            response.status(400).send('Bad request');
            return;
        }

        const items = (callback.CallbackMetadata && callback.CallbackMetadata.Item) || [];
        const meta = Object.fromEntries(items.map(function (item) {
            return [item.Name, item.Value];
        }));
        const ref = db.collection('payments').doc(callback.CheckoutRequestID);

        await db.runTransaction(async function (transaction) {
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) {
                logger.error('Callback for an unknown payment', callback);
                return;
            }
            // Safaricom can repeat a callback. Only the first one counts.
            if (snapshot.get('status') !== 'pending') return;

            let status = 'failed';
            if (callback.ResultCode === 0) {
                status = Number(meta.Amount) === snapshot.get('amount') ? 'paid' : 'review';
            }
            transaction.update(ref, {
                status,
                resultCode: callback.ResultCode,
                resultDesc: callback.ResultDesc || '',
                receipt: meta.MpesaReceiptNumber || null,
                paidAmount: meta.Amount || null,
                completedAt: FieldValue.serverTimestamp(),
            });
        });

        response.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    },
);

// ---------------------------------------------------------------------------
// Paystack: cards and Airtel Money
// ---------------------------------------------------------------------------

async function paystackRequest(path, options = {}) {
    const response = await fetch(`${PAYSTACK_API}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(function () {
        return {};
    });
    if (!response.ok || !body.status) {
        throw new Error(`Paystack ${path} failed: ${body.message || response.status}`);
    }
    return body.data;
}

// Asks Paystack what happened, then records it once. Safe to call repeatedly,
// from both the webhook and the browser.
async function settlePaystackPayment(reference) {
    const ref = db.collection('payments').doc(reference);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.get('method') !== 'paystack') return null;
    if (snapshot.get('status') !== 'pending') return snapshot.get('status');

    const transaction = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
    // 'abandoned' and 'ongoing' mean the customer has not finished yet.
    if (transaction.status !== 'success' && transaction.status !== 'failed') return 'pending';

    return db.runTransaction(async function (tx) {
        const current = await tx.get(ref);
        if (current.get('status') !== 'pending') return current.get('status');

        let status = 'failed';
        if (transaction.status === 'success') {
            const expected = current.get('amount') * 100;
            status = transaction.amount === expected && transaction.currency === current.get('currency')
                ? 'paid'
                : 'review';
        }
        tx.update(ref, {
            status,
            resultDesc: transaction.gateway_response || '',
            receipt: transaction.reference,
            channel: transaction.channel || null,
            paidAmount: transaction.amount / 100,
            completedAt: FieldValue.serverTimestamp(),
        });
        return status;
    });
}

exports.startPaystackPayment = onCall(
    { region: REGION, secrets: [PAYSTACK_SECRET_KEY] },
    async function (request) {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Please log in to pay.');
        }
        const email = request.auth.token.email;
        if (!email) {
            throw new HttpsError('failed-precondition', 'Your account needs an email address to pay.');
        }
        const plan = request.data && request.data.plan;
        if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES_KES, plan)) {
            throw new HttpsError('invalid-argument', 'That plan cannot be paid for online.');
        }
        const method = request.data.method;
        if (!Object.prototype.hasOwnProperty.call(PAYSTACK_CHANNELS, method)) {
            throw new HttpsError('invalid-argument', 'That payment method is not available.');
        }
        if (!(await claimRateLimit(request.auth.uid, 'paystack', PAYSTACK_RATE_LIMIT_MS))) {
            throw new HttpsError('resource-exhausted', 'Please wait a few seconds before trying again.');
        }

        const amount = PLAN_PRICES_KES[plan];
        const reference = `fd-${crypto.randomUUID()}`;
        let checkout;
        try {
            checkout = await paystackRequest('/transaction/initialize', {
                method: 'POST',
                body: JSON.stringify({
                    email,
                    amount: amount * 100, // Paystack takes the smallest unit (cents).
                    currency: 'KES',
                    reference,
                    channels: PAYSTACK_CHANNELS[method],
                    metadata: { uid: request.auth.uid, plan },
                }),
            });
        } catch (error) {
            logger.error('Paystack initialize failed', error);
            throw new HttpsError('unavailable', 'Payments could not be reached. Please try again in a minute.');
        }

        await db.collection('payments').doc(reference).set({
            uid: request.auth.uid,
            plan,
            amount,
            currency: 'KES',
            method: 'paystack',
            requestedMethod: method,
            email,
            status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
        });
        return { paymentId: reference, accessCode: checkout.access_code };
    },
);

// Called by the browser after Paystack's popup reports success, so the result
// shows straight away even if the webhook is slow.
exports.verifyPaystackPayment = onCall(
    { region: REGION, secrets: [PAYSTACK_SECRET_KEY] },
    async function (request) {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Please log in.');
        }
        const reference = String((request.data && request.data.reference) || '');
        const snapshot = reference && await db.collection('payments').doc(reference).get();
        if (!snapshot || !snapshot.exists || snapshot.get('uid') !== request.auth.uid) {
            throw new HttpsError('not-found', 'Payment not found.');
        }
        try {
            return { status: await settlePaystackPayment(reference) };
        } catch (error) {
            logger.error('Paystack verify failed', error);
            throw new HttpsError('unavailable', 'We could not confirm the payment yet.');
        }
    },
);

// Set this URL in Paystack dashboard > Settings > API Keys & Webhooks:
// https://us-central1-<project-id>.cloudfunctions.net/paystackWebhook
exports.paystackWebhook = onRequest(
    { region: REGION, secrets: [PAYSTACK_SECRET_KEY] },
    async function (request, response) {
        const signature = String(request.get('x-paystack-signature') || '');
        const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY.value())
            .update(request.rawBody || '')
            .digest('hex');
        const valid = request.method === 'POST'
            && signature.length === expected.length
            && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
        if (!valid) {
            response.status(401).send('Invalid signature');
            return;
        }

        const event = request.body || {};
        const reference = event.data && event.data.reference;
        if ((event.event === 'charge.success' || event.event === 'charge.failed') && reference) {
            try {
                await settlePaystackPayment(String(reference));
            } catch (error) {
                // A non-200 makes Paystack retry later.
                logger.error('Paystack webhook could not settle payment', error);
                response.status(500).send('Retry');
                return;
            }
        }
        response.sendStatus(200);
    },
);
