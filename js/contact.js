import { EMAIL_PATTERN, getFirebase, isConfigured, withTimeout } from './firebase.js';

const form = document.getElementById('contact-form');
const status = document.getElementById('form-status');
const submit = form.querySelector('button[type="submit"]');

function showStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = false;
}

if (!isConfigured) {
    document.getElementById('config-notice').hidden = false;
    submit.disabled = true;
}

// Payment options on the pricing section link here with the plan and method chosen.
const PLAN_NAMES = { unlock: 'Unlock', unleash: 'Unleash', business: 'Business' };
const METHOD_NAMES = {
    mpesa: 'M-Pesa',
    visa: 'Visa or card',
    paypal: 'PayPal',
    crypto: 'crypto',
    airtel: 'Airtel Money',
    bank: 'bank transfer',
};
const params = new URLSearchParams(location.search);
const planName = PLAN_NAMES[params.get('plan')];
const methodName = METHOD_NAMES[params.get('method')];
// Links from the alternatives and case study pages say what to replace or ask for.
const replaceTool = (params.get('replace') || '').slice(0, 80);
if (planName && methodName) {
    form.elements.message.value = `I'd like the ${planName} plan and would like to pay by ${methodName}. Please send me the payment details.`;
} else if (planName) {
    form.elements.message.value = `I'd like to talk about the ${planName} plan. Here's what we want to build: `;
} else if (params.get('topic') === 'audit') {
    form.elements.message.value = "I'd like a free SaaS audit. The tools we pay for today are: ";
} else if (replaceTool) {
    form.elements.message.value = `We'd like to replace ${replaceTool} with software we own. Here's how we use it today: `;
}

form.addEventListener('submit', async function (event) {
    event.preventDefault();

    const data = new FormData(form);
    const name = data.get('name').trim();
    const email = data.get('email').trim();
    const company = data.get('company').trim();
    const message = data.get('message').trim();

    if (!name || !message) {
        showStatus('Please fill in your name and message.', true);
        return;
    }
    if (!EMAIL_PATTERN.test(email)) {
        showStatus('Please enter a valid email address.', true);
        return;
    }

    // Only bots fill the hidden field. They see success, but nothing is saved.
    if (data.get('website')) {
        form.reset();
        showStatus('Thanks. Your message has been sent.');
        return;
    }

    submit.disabled = true;
    showStatus('Sending...');
    try {
        const { db, dbApi } = await getFirebase();
        await withTimeout(dbApi.addDoc(dbApi.collection(db, 'contactMessages'), {
            name,
            email,
            company,
            message,
            createdAt: dbApi.serverTimestamp(),
        }));
        form.reset();
        showStatus('Thanks. Your message has been sent.');
    } catch (error) {
        console.error('Contact message failed to send.', error);
        showStatus('Your message could not be sent. Please check your connection and try again.', true);
    } finally {
        submit.disabled = false;
    }
});
