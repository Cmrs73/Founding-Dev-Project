import { SDK_BASE, getFirebase, isConfigured } from './firebase.js';

// Display only. The server charges from PLAN_PRICES_KES in functions/index.js, so keep them in step.
const PLANS = {
    unlock: { name: 'Unlock', kes: 2500 },
    unleash: { name: 'Unleash', kes: 7700 },
    business: { name: 'Business' },
};

// checkout: 'mpesa' uses our Daraja STK push, 'paystack' opens Paystack's popup.
// Methods without one link to the contact form.
const METHODS = [
    { id: 'mpesa', label: 'M-Pesa', checkout: 'mpesa' },
    { id: 'visa', label: 'Visa & cards', checkout: 'paystack' },
    { id: 'paypal', label: 'PayPal' },
    { id: 'crypto', label: 'Crypto' },
    { id: 'airtel', label: 'Airtel Money', checkout: 'paystack' },
    { id: 'bank', label: 'Bank transfer' },
];

const PAYSTACK_SCRIPT = 'https://js.paystack.co/v2/inline.js';
const SUPPORTS_DIALOG = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;

const WAIT_FOR_RESULT_MS = 120 * 1000;
const PHONE_PATTERN = /^(?:\+?254|0)?[17]\d{8}$/;
const MESSAGE_CODES = ['functions/invalid-argument', 'functions/resource-exhausted', 'functions/unavailable', 'functions/unauthenticated'];

const dialog = document.getElementById('mpesa-dialog');
const form = document.getElementById('mpesa-form');
const title = document.getElementById('mpesa-title');
const fields = document.getElementById('mpesa-fields');
const loginPrompt = document.getElementById('mpesa-login');
const submit = document.getElementById('mpesa-submit');
const status = document.getElementById('mpesa-status');

let currentPlan = null;
let stopWatching = null;

function createOption(planId, method) {
    // Browsers without <dialog> (Safari before 15.4) get the contact form instead.
    const isCheckout = Boolean(method.checkout) && Boolean(PLANS[planId].kes) && SUPPORTS_DIALOG;
    const option = document.createElement(isCheckout ? 'button' : 'a');
    option.className = 'pay-option';
    option.textContent = method.label;

    if (isCheckout) {
        option.type = 'button';
        const tag = document.createElement('span');
        tag.className = 'pay-option-tag';
        tag.textContent = 'Instant';
        option.append(tag);
        option.addEventListener('click', function () {
            if (method.checkout === 'paystack') {
                openPaystack(planId, method);
            } else {
                openCheckout(planId);
            }
        });
    } else {
        option.href = `contact.html?plan=${planId}&method=${method.id}`;
    }
    return option;
}

function renderMenus() {
    document.querySelectorAll('[data-pay-plan]').forEach(function (container) {
        const planId = container.dataset.payPlan;
        const menu = container.querySelector('.pay-menu-inner');
        METHODS.forEach(function (method) {
            menu.append(createOption(planId, method));
        });
        const note = document.createElement('p');
        note.className = 'pay-note';
        note.textContent = PLANS[planId].kes
            ? 'M-Pesa, cards and Airtel Money are instant. For the others, we reply with payment details.'
            : 'We agree your price first, then send payment details.';
        menu.append(note);

        // iOS does not focus a button on tap, which the menu relies on.
        container.querySelector('.pay-toggle').addEventListener('click', function (event) {
            event.currentTarget.focus();
        });
    });

    // A plan's main button opens its payment menu.
    document.querySelectorAll('[data-open-pay]').forEach(function (button) {
        button.addEventListener('click', function (event) {
            const toggle = button.closest('.plan').querySelector('.pay-toggle');
            if (!toggle) return;
            // Stop the page-wide click handler from closing the menu straight away.
            event.stopPropagation();
            toggle.scrollIntoView({ block: 'center', behavior: 'smooth' });
            toggle.focus({ preventScroll: true });
        });
    });
}

function showStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = false;
}

function stopWatchingPayment() {
    if (stopWatching) stopWatching();
    stopWatching = null;
}

async function openCheckout(planId) {
    currentPlan = planId;
    const plan = PLANS[planId];
    title.textContent = `Pay KES ${plan.kes.toLocaleString('en-KE')} with M-Pesa`;
    form.reset();
    status.hidden = true;
    fields.hidden = false;
    loginPrompt.hidden = true;
    submit.hidden = false;
    submit.disabled = true;
    dialog.showModal();

    if (!isConfigured) {
        showStatus('Payments are not connected yet.', true);
        return;
    }
    try {
        const firebase = await getFirebase();
        await firebase.auth.authStateReady();
        if (firebase.auth.currentUser) {
            submit.disabled = false;
        } else {
            fields.hidden = true;
            submit.hidden = true;
            loginPrompt.hidden = false;
        }
    } catch (error) {
        console.error('Firebase failed to load.', error);
        showStatus('Payments could not load. Please check your connection and try again.', true);
    }
}

function watchPayment(firebase, paymentId) {
    const { db, dbApi } = firebase;
    const timer = setTimeout(function () {
        stopWatchingPayment();
        submit.disabled = false;
        showStatus('We have not heard back from M-Pesa yet. If you entered your PIN, keep your M-Pesa SMS and contact us. Otherwise you can try again.', true);
    }, WAIT_FOR_RESULT_MS);

    const unsubscribe = dbApi.onSnapshot(dbApi.doc(db, 'payments', paymentId), function (snapshot) {
        const payment = snapshot.data();
        if (!payment || payment.status === 'pending') return;
        stopWatchingPayment();
        if (payment.status === 'paid') {
            fields.hidden = true;
            submit.hidden = true;
            showStatus(`Payment received. Your M-Pesa receipt is ${payment.receipt}.`);
        } else if (payment.status === 'review') {
            showStatus('Your payment came through, but the amount needs checking. Please contact us and quote your M-Pesa SMS.', true);
        } else {
            submit.disabled = false;
            showStatus('The payment did not go through, and you were not charged. You can try again.', true);
        }
    }, function (error) {
        console.error('Could not watch the payment.', error);
    });

    stopWatching = function () {
        clearTimeout(timer);
        unsubscribe();
    };
}

form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const phone = form.elements.phone.value.replace(/[\s-]/g, '');
    if (!PHONE_PATTERN.test(phone)) {
        showStatus('Please enter a valid Safaricom number, like 0712 345 678.', true);
        return;
    }

    submit.disabled = true;
    stopWatchingPayment();
    showStatus('Sending the M-Pesa prompt...');
    try {
        const firebase = await getFirebase();
        const functionsApi = await import(`${SDK_BASE}/firebase-functions.js`);
        const startPayment = functionsApi.httpsCallable(
            functionsApi.getFunctions(firebase.auth.app),
            'startMpesaPayment',
        );
        const result = await startPayment({ plan: currentPlan, phone });
        showStatus('Check your phone and enter your M-Pesa PIN to finish.');
        watchPayment(firebase, result.data.paymentId);
    } catch (error) {
        console.error('M-Pesa payment failed to start.', error);
        submit.disabled = false;
        showStatus(MESSAGE_CODES.includes(error.code) ? error.message : 'Something went wrong. Please try again.', true);
    }
});

document.getElementById('mpesa-close').addEventListener('click', function () {
    dialog.close();
});
dialog.addEventListener('close', stopWatchingPayment);

// Closes a menu opened by tap or keyboard. A dialog handles its own Escape key.
function closeOpenMenu() {
    const active = document.activeElement;
    if (active && active.closest('.plan-pay')) active.blur();
}
function anyDialogOpen() {
    return dialog.open || psDialog.open;
}
document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !anyDialogOpen()) closeOpenMenu();
});
document.addEventListener('click', function (event) {
    if (!anyDialogOpen() && !event.target.closest('.plan-pay')) closeOpenMenu();
});

// ---------------------------------------------------------------------------
// Paystack: cards and Airtel Money
// ---------------------------------------------------------------------------

const psDialog = document.getElementById('paystack-dialog');
const psForm = document.getElementById('paystack-form');
const psTitle = document.getElementById('paystack-title');
const psIntro = document.getElementById('paystack-intro');
const psLogin = document.getElementById('paystack-login');
const psSubmit = document.getElementById('paystack-submit');
const psStatus = document.getElementById('paystack-status');
const PS_MESSAGE_CODES = MESSAGE_CODES.concat(['functions/failed-precondition']);

let psPlan = null;
let psMethod = null;
let psStopWatching = null;
let paystackLoader = null;

function showPsStatus(message, isError) {
    psStatus.textContent = message;
    psStatus.classList.toggle('is-error', Boolean(isError));
    psStatus.hidden = false;
}

function stopWatchingPaystack() {
    if (psStopWatching) psStopWatching();
    psStopWatching = null;
}

function loadPaystack() {
    if (window.PaystackPop) return Promise.resolve(window.PaystackPop);
    if (!paystackLoader) {
        paystackLoader = new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.src = PAYSTACK_SCRIPT;
            script.async = true;
            script.onload = function () {
                resolve(window.PaystackPop);
            };
            script.onerror = function () {
                paystackLoader = null;
                script.remove();
                reject(new Error('Paystack failed to load'));
            };
            document.head.append(script);
        });
    }
    return paystackLoader;
}

async function openPaystack(planId, method) {
    psPlan = planId;
    psMethod = method.id;
    const plan = PLANS[planId];
    psTitle.textContent = `Pay KES ${plan.kes.toLocaleString('en-KE')} with ${method.label}`;
    psIntro.hidden = false;
    psStatus.hidden = true;
    psLogin.hidden = true;
    psSubmit.hidden = false;
    psSubmit.disabled = true;
    stopWatchingPaystack();
    psDialog.showModal();

    if (!isConfigured) {
        showPsStatus('Payments are not connected yet.', true);
        return;
    }
    try {
        const firebase = await getFirebase();
        await firebase.auth.authStateReady();
        if (firebase.auth.currentUser) {
            psSubmit.disabled = false;
            loadPaystack().catch(function () {}); // Warm up, so the popup opens quickly.
        } else {
            psIntro.hidden = true;
            psSubmit.hidden = true;
            psLogin.hidden = false;
        }
    } catch (error) {
        console.error('Firebase failed to load.', error);
        showPsStatus('Payments could not load. Please check your connection and try again.', true);
    }
}

function showPaystackResult(payment) {
    if (!payment || payment.status === 'pending') return;
    stopWatchingPaystack();
    if (payment.status === 'paid') {
        psIntro.hidden = true;
        psSubmit.hidden = true;
        showPsStatus(`Payment received. Your reference is ${payment.receipt}.`);
    } else if (payment.status === 'review') {
        psSubmit.hidden = true;
        showPsStatus(`Your payment came through, but the amount needs checking. Please contact us and quote ${payment.receipt}.`, true);
    } else {
        psSubmit.disabled = false;
        showPsStatus('The payment did not go through, and you were not charged. You can try again.', true);
    }
}

function watchPaystack(firebase, paymentId) {
    const { db, dbApi } = firebase;
    const timer = setTimeout(function () {
        stopWatchingPaystack();
        psSubmit.disabled = false;
        showPsStatus(`We have not confirmed your payment yet. If you were charged, contact us and quote ${paymentId}.`, true);
    }, WAIT_FOR_RESULT_MS);

    const unsubscribe = dbApi.onSnapshot(dbApi.doc(db, 'payments', paymentId), function (snapshot) {
        showPaystackResult(snapshot.data());
    }, function (error) {
        console.error('Could not watch the payment.', error);
    });

    psStopWatching = function () {
        clearTimeout(timer);
        unsubscribe();
    };
}

async function callFunction(firebase, name, data) {
    const functionsApi = await import(`${SDK_BASE}/firebase-functions.js`);
    const callable = functionsApi.httpsCallable(functionsApi.getFunctions(firebase.auth.app), name);
    return (await callable(data)).data;
}

psForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    psSubmit.disabled = true;
    stopWatchingPaystack();
    showPsStatus('Opening secure checkout...');

    let firebase;
    let checkout;
    let PaystackPop;
    try {
        firebase = await getFirebase();
        [checkout, PaystackPop] = await Promise.all([
            callFunction(firebase, 'startPaystackPayment', { plan: psPlan, method: psMethod }),
            loadPaystack(),
        ]);
    } catch (error) {
        console.error('Paystack payment failed to start.', error);
        psSubmit.disabled = false;
        showPsStatus(PS_MESSAGE_CODES.includes(error.code) ? error.message : 'Something went wrong. Please try again.', true);
        return;
    }

    // A modal dialog sits above everything, so ours steps aside for Paystack's popup.
    psDialog.close();
    function reopen() {
        if (!psDialog.open) psDialog.showModal();
    }

    new PaystackPop().resumeTransaction(checkout.accessCode, {
        onSuccess: async function () {
            reopen();
            showPsStatus('Confirming your payment...');
            watchPaystack(firebase, checkout.paymentId);
            try {
                const result = await callFunction(firebase, 'verifyPaystackPayment', { reference: checkout.paymentId });
                showPaystackResult({ status: result.status, receipt: checkout.paymentId });
            } catch (error) {
                // The webhook still settles it, and the watcher shows the result.
                console.error('Could not verify the payment.', error);
            }
        },
        onCancel: function () {
            reopen();
            psSubmit.disabled = false;
            showPsStatus('Payment cancelled. You were not charged.', true);
        },
        onError: function (error) {
            console.error('Paystack checkout error.', error);
            reopen();
            psSubmit.disabled = false;
            showPsStatus('Checkout could not open. Please try again.', true);
        },
    });
});

// Our own close for the popup is not the customer leaving, so only these stop the watcher.
document.getElementById('paystack-close').addEventListener('click', function () {
    stopWatchingPaystack();
    psDialog.close();
});
psDialog.addEventListener('cancel', stopWatchingPaystack);

renderMenus();
