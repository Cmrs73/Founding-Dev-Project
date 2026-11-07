import { EMAIL_PATTERN, getFirebase, isConfigured, withTimeout } from './firebase.js';

const heading = document.getElementById('page-heading');
const authPanel = document.getElementById('auth-panel');
const authForm = document.getElementById('auth-form');
const authSubmit = document.getElementById('auth-submit');
const authStatus = document.getElementById('auth-status');
const passwordField = document.getElementById('password-field');
const passwordInput = authForm.elements.password;
const modeButtons = document.querySelectorAll('[data-mode]');

const dashboard = document.getElementById('dashboard');
const userEmail = document.getElementById('user-email');
const signOutButton = document.getElementById('sign-out');

const MODES = {
    login: { heading: 'Log in', submit: 'Log in', autocomplete: 'current-password' },
    signup: { heading: 'Create your account', submit: 'Create account', autocomplete: 'new-password' },
    reset: { heading: 'Reset your password', submit: 'Send reset link', autocomplete: 'off' },
};

const AUTH_ERRORS = {
    'auth/email-already-in-use': 'An account with this email already exists. Try logging in.',
    'auth/invalid-credential': 'That email and password do not match.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/network-request-failed': 'Could not connect. Please check your connection and try again.',
    'auth/operation-not-allowed': 'Email and password sign-in is not enabled for this project yet.',
    'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
    'auth/weak-password': 'Please choose a stronger password.',
};

let mode = 'login';
let firebase = null;

function showStatus(element, message, isError) {
    element.textContent = message;
    element.classList.toggle('is-error', Boolean(isError));
    element.hidden = false;
}

function setMode(next) {
    mode = MODES[next] ? next : 'login';
    const settings = MODES[mode];
    heading.textContent = settings.heading;
    authSubmit.textContent = settings.submit;
    passwordField.hidden = mode === 'reset';
    passwordInput.autocomplete = settings.autocomplete;
    authStatus.hidden = true;
    modeButtons.forEach(function (button) {
        button.hidden = button.dataset.mode === mode;
    });
    // "Log in" is reached through "Back to log in", so "Forgot password?" only shows on login.
    document.querySelector('[data-mode="reset"]').hidden = mode !== 'login';
    document.querySelector('[data-mode="signup"]').hidden = mode === 'signup' || mode === 'reset';
}

async function ensureProfile(user) {
    const { db, dbApi } = firebase;
    const ref = dbApi.doc(db, 'users', user.uid);
    try {
        const snapshot = await withTimeout(dbApi.getDoc(ref));
        if (!snapshot.exists()) {
            await withTimeout(dbApi.setDoc(ref, { email: user.email, createdAt: dbApi.serverTimestamp() }));
        }
    } catch (error) {
        // The account still works without this record, so the page carries on.
        console.error('Account record failed to save.', error);
    }
}

function showSignedIn(user) {
    // People sent here from checkout go back to the plan they were buying.
    if (new URLSearchParams(location.search).get('return') === 'pricing') {
        location.replace('pricing.html#plans');
        return;
    }
    authPanel.hidden = true;
    dashboard.hidden = false;
    heading.textContent = 'Your account';
    userEmail.textContent = user.email;
    ensureProfile(user);
}

function showSignedOut() {
    dashboard.hidden = true;
    authPanel.hidden = false;
    authForm.reset();
    setMode(new URLSearchParams(location.search).get('mode') || 'login');
}

authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!firebase) return;

    const { auth, authApi } = firebase;
    const email = authForm.elements.email.value.trim();
    const password = passwordInput.value;

    if (!EMAIL_PATTERN.test(email)) {
        showStatus(authStatus, 'Please enter a valid email address.', true);
        return;
    }
    if (mode !== 'reset' && !password) {
        showStatus(authStatus, 'Please enter your password.', true);
        return;
    }
    if (mode === 'signup' && password.length < 8) {
        showStatus(authStatus, 'Please use at least 8 characters for your password.', true);
        return;
    }

    authSubmit.disabled = true;
    authStatus.hidden = true;
    try {
        if (mode === 'signup') {
            await authApi.createUserWithEmailAndPassword(auth, email, password);
        } else if (mode === 'login') {
            await authApi.signInWithEmailAndPassword(auth, email, password);
        } else {
            await authApi.sendPasswordResetEmail(auth, email);
            showStatus(authStatus, 'If an account exists for that email, a reset link is on its way.');
        }
    } catch (error) {
        // A reset must not reveal whether an email has an account.
        if (mode === 'reset' && error.code === 'auth/user-not-found') {
            showStatus(authStatus, 'If an account exists for that email, a reset link is on its way.');
        } else {
            console.error('Authentication failed.', error);
            showStatus(authStatus, AUTH_ERRORS[error.code] || 'Something went wrong. Please try again.', true);
        }
    } finally {
        authSubmit.disabled = !firebase;
    }
});

modeButtons.forEach(function (button) {
    button.addEventListener('click', function () {
        setMode(button.dataset.mode);
    });
});

signOutButton.addEventListener('click', function () {
    firebase.authApi.signOut(firebase.auth);
});

showSignedOut();

if (!isConfigured) {
    document.getElementById('config-notice').hidden = false;
    authSubmit.disabled = true;
} else {
    authSubmit.disabled = true;
    getFirebase().then(function (services) {
        firebase = services;
        authSubmit.disabled = false;
        firebase.authApi.onAuthStateChanged(firebase.auth, function (user) {
            if (user) {
                showSignedIn(user);
            } else {
                showSignedOut();
            }
        });
    }).catch(function (error) {
        console.error('Firebase failed to load.', error);
        showStatus(authStatus, 'Accounts could not load. Please check your connection and refresh.', true);
    });
}
