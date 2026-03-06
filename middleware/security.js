/**
 * Security middleware and helpers for Naujan Tourism.
 * - Safe redirect (prevents open redirect)
 * - Input length limits and validation helpers
 */

/** Allowed redirect: must be a path starting with / and not // (no protocol-relative or absolute URLs) */
function safeRedirectUrl(url) {
    const s = (url && typeof url === 'string') ? url.trim() : '';
    if (!s) return '/';
    if (s.startsWith('//') || s.includes('://')) return '/';
    if (!s.startsWith('/')) return '/';
    return s;
}

/** Basic email format check (reject obviously invalid) */
function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    const e = email.trim().toLowerCase();
    return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Reasonable length limits for user input */
const LIMITS = {
    contactName: 200,
    contactSubject: 300,
    contactMessage: 5000,
    reviewText: 2000,
    reportReason: 500,
    displayName: 100,
};

function truncateOrNull(str, maxLen) {
    if (str == null) return null;
    const s = String(str).trim();
    return s.length > maxLen ? s.slice(0, maxLen) : s;
}

module.exports = {
    safeRedirectUrl,
    isValidEmailFormat,
    LIMITS,
    truncateOrNull,
};
