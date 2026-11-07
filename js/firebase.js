import { firebaseConfig } from './firebase-config.js';

export const SDK_BASE = 'https://www.gstatic.com/firebasejs/10.14.1';

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

let services = null;

// The SDK loads on demand, so the pages still render if it is unavailable.
export function getFirebase() {
    if (!isConfigured) return Promise.resolve(null);
    if (!services) {
        services = Promise.all([
            import(`${SDK_BASE}/firebase-app.js`),
            import(`${SDK_BASE}/firebase-auth.js`),
            import(`${SDK_BASE}/firebase-firestore.js`),
        ]).then(function ([appApi, authApi, dbApi]) {
            const app = appApi.initializeApp(firebaseConfig);
            return { auth: authApi.getAuth(app), db: dbApi.getFirestore(app), authApi, dbApi };
        });
    }
    return services;
}

// Firestore waits silently while offline, so writes need their own time limit.
export function withTimeout(promise, ms = 15000) {
    let timer;
    const timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () {
            const error = new Error('Request timed out');
            error.code = 'timeout';
            reject(error);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () {
        clearTimeout(timer);
    });
}

export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
