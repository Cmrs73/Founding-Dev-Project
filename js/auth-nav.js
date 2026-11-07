import { getFirebase } from './firebase.js';

// The header has these links twice: in the bar, and inside the phone menu.
const logins = document.querySelectorAll('[data-auth="login"]');
const primaries = document.querySelectorAll('[data-auth="primary"]');

getFirebase().then(function (firebase) {
    if (!firebase || !primaries.length) return;
    firebase.authApi.onAuthStateChanged(firebase.auth, function (user) {
        logins.forEach(function (login) {
            login.hidden = Boolean(user);
        });
        primaries.forEach(function (primary) {
            primary.textContent = user ? 'Account' : 'Start replacing';
            primary.href = user ? 'account.html' : 'account.html?mode=signup';
        });
    });
}).catch(function (error) {
    console.warn('Firebase failed to load; showing the signed-out header.', error);
});
