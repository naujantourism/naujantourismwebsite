require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const https = require('https');
const admin = require('firebase-admin');
const multer = require('multer');
const app = express();
const port = 3000;

// Supabase Storage (optional): used on Vercel where filesystem is read-only
const SUPABASE_BUCKET = 'tourism-images';
let _supabase = undefined;
function getSupabase() {
    if (_supabase !== undefined) return _supabase;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        try {
            const { createClient } = require('@supabase/supabase-js');
            _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        } catch (e) {
            _supabase = null;
        }
    } else {
        _supabase = null;
    }
    return _supabase;
}

// Vercel runs behind a proxy/CDN. Trust it so secure cookies work correctly.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'naujan-tourism-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: 'auto',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));
app.use((req, res, next) => {
    res.locals.user = req.session && req.session.email
        ? { id: req.session.userId, email: req.session.email, role: req.session.role, name: req.session.name || req.session.email }
        : null;
    const { favorites, ratings } = getCurrentUserFavsAndRatings(req.session && req.session.userId);
    res.locals.userFavorites = favorites;
    res.locals.userRatings = ratings;
    next();
});
app.use((req, res, next) => {
    res.locals.imageBaseUrl = process.env.IMAGE_BASE_URL || '';
    next();
});

// --- Firebase Initialization ---
let adminConfig;

if (process.env.FIREBASE_PRIVATE_KEY) {
    // Vercel Production
    adminConfig = {
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // This replace fixes Vercel's habit of escaping newlines
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: 'https://naujantourism-ad6a6-default-rtdb.firebaseio.com/'
    };
} else {
    // Local Development
    const serviceAccount = require('./firebase-key.json');
    adminConfig = {
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://naujantourism-ad6a6-default-rtdb.firebaseio.com/'
    };
}

admin.initializeApp(adminConfig);
const db = admin.database();
const usersRef = db.ref('/users');
const attractionsRef = db.ref('/attractions');
const reviewsRef = db.ref('/reviews');
const reportsRef = db.ref('/reports');
const categoriesRef = db.ref('/categories');

// --- Auth: user accounts in Firebase RTDB (email, password hashed, role hashed) ---
const SALT_ROUNDS = 10;
const ROLE_USER = 'user';
const ROLE_ADMIN = 'admin';

// --- Email verification / mailer setup ---
const VERIFICATION_TOKEN_BYTES = 32;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    } : undefined
});

async function sendVerificationEmail(toEmail, token, baseUrl) {
    const verifyUrl = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(toEmail)}`;

    // If SMTP is not configured, just log the link so local dev still works
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log('Email verification link for', toEmail, ':', verifyUrl);
        return;
    }

    const fromAddress = process.env.EMAIL_FROM || '"Naujan Tourism" <no-reply@naujantourism.local>';

    await mailTransport.sendMail({
        from: fromAddress,
        to: toEmail,
        subject: 'Verify your email for Visit Naujan',
        text: `Welcome to Visit Naujan!

Please verify your email address by opening this link:
${verifyUrl}

If you did not create this account, you can safely ignore this email.`,
        html: `<p>Welcome to <strong>Visit Naujan</strong>!</p>
<p>Please verify your email address by clicking the button below:</p>
<p><a href="${verifyUrl}" style="display:inline-block;padding:10px 18px;background:#0d6efd;color:#ffffff;text-decoration:none;border-radius:4px;">Verify my email</a></p>
<p>Or copy and paste this link into your browser:<br><code>${verifyUrl}</code></p>
<p>If you did not create this account, you can safely ignore this email.</p>`
    });
}

const CONTACT_EMAIL_TO = 'naujantourismwebsite@gmail.com';

async function sendContactEmail(name, fromEmail, subject, message) {
    const fromAddress = process.env.EMAIL_FROM || '"Naujan Tourism" <no-reply@naujantourism.local>';
    const subj = subject && subject.trim() ? subject.trim() : 'Contact form – Visit Naujan';
    const bodyText = `Name: ${name || '—'}\nEmail: ${fromEmail || '—'}\n\nMessage:\n${message || '—'}`;
    const bodyHtml = `<p><strong>Name:</strong> ${escapeHtml(name || '—')}</p><p><strong>Email:</strong> ${escapeHtml(fromEmail || '—')}</p><p><strong>Message:</strong></p><p>${escapeHtml(message || '—').replace(/\n/g, '<br>')}</p>`;

    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log('Contact form (SMTP not configured):', { to: CONTACT_EMAIL_TO, name, fromEmail, subject: subj, message: (message || '').slice(0, 100) + '...' });
        return;
    }

    await mailTransport.sendMail({
        from: fromAddress,
        to: CONTACT_EMAIL_TO,
        replyTo: fromEmail || undefined,
        subject: `[Visit Naujan Contact] ${subj}`,
        text: bodyText,
        html: bodyHtml
    });
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function hashRole(role) {
    return bcrypt.hash(role, SALT_ROUNDS);
}

/** Find user by email. Requires Firebase RTDB index on /users: ".indexOn": ["email"] */
async function findUserByEmail(email) {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    const snapshot = await usersRef.orderByChild('email').equalTo(normalized).once('value');
    const val = snapshot.val();
    if (!val) return null;
    const uid = Object.keys(val)[0];
    return { uid, ...val[uid] };
}

async function createUser(email, plainPassword, role, name, options = {}) {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized || !plainPassword) throw new Error('Email and password required');
    const existing = await findUserByEmail(normalized);
    if (existing) throw new Error('Email already registered');
    const passwordHash = await bcrypt.hash(plainPassword, SALT_ROUNDS);
    const roleHash = await hashRole(role);
    const displayName = (name || '').trim() || '';
    const newRef = usersRef.push();
    const verified = (typeof options.verified === 'boolean') ? options.verified : (role === ROLE_ADMIN);
    const verificationToken = options.verificationToken || null;
    const verificationExpires = options.verificationExpires || null;
    await newRef.set({
        email: normalized,
        passwordHash,
        roleHash,
        name: displayName,
        verified,
        verificationToken,
        verificationExpires
    });
    return newRef.key;
}

async function getUserById(uid) {
    if (!uid) return null;
    const snapshot = await usersRef.child(uid).once('value');
    const val = snapshot.val();
    return val ? { uid, ...val } : null;
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

async function isRole(user, role) {
    return user && user.roleHash && bcrypt.compare(role, user.roleHash);
}

/** Ensure one admin account exists (from env). Call once on startup. */
async function ensureAdminExists() {
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) return;
    const existing = await findUserByEmail(adminEmail);
    if (existing) {
        const ok = await isRole(existing, ROLE_ADMIN);
        if (ok) return;
    }
    try {
        if (existing) {
            const roleHash = await hashRole(ROLE_ADMIN);
            await usersRef.child(existing.uid).update({ roleHash });
        } else {
            await createUser(adminEmail, adminPassword, ROLE_ADMIN, 'Admin');
        }
        console.log('Admin account ready for', adminEmail);
    } catch (e) {
        console.warn('ensureAdminExists:', e.message);
    }
}

const requireAdmin = (req, res, next) => {
    if (!req.session || req.session.role !== ROLE_ADMIN) {
        return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl || '/admin/dashboard'));
    }
    next();
};

const requireAdminApi = (req, res, next) => {
    if (!req.session || req.session.role !== ROLE_ADMIN) {
        return res.status(401).json({ error: 'Admin required' });
    }
    next();
};

// --- Visit tracking (persisted to Firebase RTDB) ---
const RESET_AFTER_DAYS = 30;
let visitCounts = {}; // { attractionId: number }
let lastResetAt = null; // Date string (ISO) when counts were last reset

function loadVisits() {
    db.ref('/visits').once('value').then((snapshot) => {
        const data = snapshot.val();
        if (data) {
            visitCounts = data.counts || {};
            lastResetAt = data.lastReset || new Date().toISOString();
        } else {
            visitCounts = {};
            lastResetAt = new Date().toISOString();
            saveVisits();
        }
        maybeResetIfMonthPassed();

        // Listen for future changes
        db.ref('/visits').on('value', (s) => {
            const d = s.val();
            if (d) {
                visitCounts = d.counts || {};
                lastResetAt = d.lastReset || lastResetAt;
            } else {
                visitCounts = {};
            }
        });
    }).catch(error => {
        console.error('Error reading visits from Firebase:', error);
    });
}

function saveVisits() {
    return db.ref('/visits').set({
        lastReset: lastResetAt || new Date().toISOString(),
        counts: visitCounts
    }).catch(e => {
        console.error('Could not save visit counts to Firebase:', e.message);
    });
}

/** If last reset was more than RESET_AFTER_DAYS ago, clear counts and set new reset date. */
async function maybeResetIfMonthPassed() {
    if (!lastResetAt) {
        lastResetAt = new Date().toISOString();
        await saveVisits();
        return;
    }
    const then = new Date(lastResetAt).getTime();
    const now = Date.now();
    const daysSince = (now - then) / (1000 * 60 * 60 * 24);
    if (daysSince >= RESET_AFTER_DAYS) {
        visitCounts = {};
        lastResetAt = new Date().toISOString();
        await saveVisits();
    }
}

/** Manually reset all visit counts and set lastReset to now. */
async function resetVisits() {
    visitCounts = {};
    lastResetAt = new Date().toISOString();
    return await saveVisits();
}

/** Record one visit for an attraction by id. Call this when someone views the attraction page. */
async function recordVisit(attractionId) {
    if (!attractionId) return;
    await maybeResetIfMonthPassed();
    visitCounts[attractionId] = (visitCounts[attractionId] || 0) + 1;
    
    // Create a 1.5-second timeout to prevent the page from hanging if Firebase fails
    const timeoutPromise = new Promise(resolve => setTimeout(() => {
        console.warn('Firebase save timed out, skipping to load page.');
        resolve();
    }, 1500));

    // Race the Firebase save against the 1.5 second timeout
    await Promise.race([saveVisits(), timeoutPromise]); 
}

// --- Favorites and Ratings tracking (persisted to Firebase RTDB) ---
let favData = {}; // { attractionId: { favorites: 0, ratingSum: 0, ratingCount: 0 } }

function loadFavs() {
    db.ref('/favs').once('value').then((snapshot) => {
        const data = snapshot.val();
        if (data) {
            favData = data;
        } else {
            favData = {};
            saveFavs();
        }

        // Listen for future changes
        db.ref('/favs').on('value', (s) => {
            const d = s.val();
            favData = d || {};
        });
    }).catch(error => {
        console.error('Error reading favs from Firebase:', error);
    });
}

function saveFavs() {
    return db.ref('/favs').set(favData).catch(e => {
        console.error('Could not save favorites to Firebase:', e.message);
    });
}

/** Manually reset all favorites and ratings */
async function resetFavs() {
    favData = {};
    return await saveFavs();
}

function getAttractionStats(id) {
    const f = favData[id] || { favorites: 0, ratingSum: 0, ratingCount: 0 };
    return {
        favoritesCount: f.favorites || 0,
        ratingSum: f.ratingSum || 0,
        ratingCount: f.ratingCount || 0,
        avgRating: f.ratingCount > 0 ? (f.ratingSum / f.ratingCount).toFixed(1) : 0
    };
}

/** Get reviews for an attraction (sorted by createdAt desc), including nested replies. */
async function getReviewsForAttraction(attractionId) {
    const snapshot = await reviewsRef.child(attractionId).once('value');
    const val = snapshot.val();
    if (!val) return [];

    const list = Object.entries(val).map(([id, r]) => {
        const review = { id, ...r };

        const repliesObj = r && typeof r.replies === 'object' ? r.replies : null;
        if (repliesObj) {
            const flatReplies = Object.entries(repliesObj).map(([rid, rr]) => ({
                id: rid,
                ...rr
            }));

            // Build up to two levels of nesting using parentReplyId
            const replyMap = {};
            flatReplies.forEach(rep => {
                rep.children = [];
                replyMap[rep.id] = rep;
            });

            const topLevel = [];
            flatReplies.forEach(rep => {
                if (rep.parentReplyId && replyMap[rep.parentReplyId]) {
                    replyMap[rep.parentReplyId].children.push(rep);
                } else {
                    topLevel.push(rep);
                }
            });

            const sortByDateAsc = (arr) => {
                arr.sort((a, b) => (new Date(a.createdAt) || 0) - (new Date(b.createdAt) || 0));
            };

            sortByDateAsc(topLevel);
            topLevel.forEach(rep => {
                if (Array.isArray(rep.children) && rep.children.length) {
                    sortByDateAsc(rep.children);
                }
            });

            review.replies = topLevel;
        } else {
            review.replies = [];
        }

        return review;
    });

    list.sort((a, b) => (new Date(b.createdAt) || 0) - (new Date(a.createdAt) || 0));
    return list;
}

/** Add a review (requires userId, userEmail in session; userName optional). Returns the new review or null. */
async function addReview(attractionId, text, userId, userEmail, userName) {
    const trimmed = (text || '').trim();
    if (!trimmed || !userId || !userEmail) return null;
    const ref = reviewsRef.child(attractionId).push();
    const review = {
        userId,
        userEmail,
        userName: (userName || '').trim() || userEmail,
        text: trimmed,
        createdAt: new Date().toISOString(),
        reactions: {}
    };
    await ref.set(review);
    return { id: ref.key, ...review };
}

/** Add a reply to a review, optionally nested under another reply (via parentReplyId). */
async function addReply(attractionId, reviewId, text, userId, userEmail, userName, parentReplyId) {
    const trimmed = (text || '').trim();
    if (!trimmed || !userId || !userEmail || !attractionId || !reviewId) return null;
    const ref = reviewsRef.child(attractionId).child(reviewId).child('replies').push();
    const reply = {
        userId,
        userEmail,
        userName: (userName || '').trim() || userEmail,
        text: trimmed,
        createdAt: new Date().toISOString(),
        parentReplyId: parentReplyId || null
    };
    await ref.set(reply);
    return { id: ref.key, ...reply };
}

/** Get the list of attraction IDs favorited and ratings by a user (for res.locals). */
function getCurrentUserFavsAndRatings(userId) {
    const favorites = [];
    const ratings = {};
    if (!userId) return { favorites, ratings };
    for (const [attractionId, data] of Object.entries(favData)) {
        if (data.favoritedBy && data.favoritedBy[userId]) favorites.push(attractionId);
        if (data.ratedBy && typeof data.ratedBy[userId] === 'number') ratings[attractionId] = data.ratedBy[userId];
    }
    return { favorites, ratings };
}

/** Get all attractions with their visit counts, sorted by visits descending (most visited first). */
function getAttractionsWithVisits() {
    return attractions.map(a => ({
        ...a,
        visits: visitCounts[a.id] || 0,
        stats: getAttractionStats(a.id)
    })).sort((a, b) => b.visits - a.visits);
}

loadVisits();
loadFavs();
ensureAdminExists();

// Attractions: loaded from Firebase (or seeded from initialAttractions)
let attractions = [];

function getAttractionsSource() {
    // On first cold start (e.g. Vercel serverless), Firebase may not have loaded yet.
    // Fall back to the static initialAttractions so pages never render empty.
    if (Array.isArray(attractions) && attractions.length > 0) return attractions;
    return initialAttractions;
}

function getActiveAttractions() {
    return getAttractionsSource().filter(a => a.active !== false);
}

/** Remove undefined values recursively (Firebase rejects undefined). */
function stripUndefined(obj) {
    if (obj === undefined) return null;
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripUndefined).filter(v => v !== undefined);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const cleaned = stripUndefined(v);
        if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
}

function saveAttractionsToFirebase() {
    const obj = {};
    attractions.forEach(a => {
        const { id, ...rest } = a;
        const cleaned = stripUndefined({ ...rest, id });
        if (cleaned && id) obj[id] = cleaned;
    });
    return attractionsRef.set(obj).catch(e => console.error('Could not save attractions to Firebase:', e.message));
}

function loadAttractions() {
    attractionsRef.once('value').then(snapshot => {
        const val = snapshot.val();
        if (val && Object.keys(val).length > 0) {
            attractions = Object.values(val).map(a => ({ ...a, active: a.active !== false }));
        } else {
            attractions = initialAttractions.map(a => ({ ...a, active: a.active !== false }));
            saveAttractionsToFirebase();
        }
        attractionsRef.on('value', s => {
            const v = s.val();
            if (v && Object.keys(v).length > 0) attractions = Object.values(v).map(a => ({ ...a, active: a.active !== false }));
        });
    }).catch(err => {
        console.error('Error loading attractions from Firebase:', err);
        attractions = initialAttractions.map(a => ({ ...a, active: a.active !== false }));
    });
}

// Initial seed data: Real spots in Naujan, Oriental Mindoro (used when Firebase is empty)
const initialAttractions = [
    {
        id: 'naujan-lake',
        highlights: 'A breathtaking biodiversity hotspot and birdwatching paradise on the Philippines\' fifth-largest lake.',
        uniqueHighlight: 'Oriental Mindoro’s only nationally protected lake park, offering an unforgettable mix of serene lake cruises, vibrant birdwatching, and sweeping mountain panoramas.',
        name: 'Naujan Lake National Park',
        category: 'Nature',
        image: '/images/lake.jpg',
        desc: 'Discover the untamed beauty of the Philippines\' fifth-largest lake. This sprawling biodiversity hotspot offers a tranquil escape where you can glide across glass-like waters, marvel at migratory birds, and soak in breathtaking sunsets framed by majestic mountain ranges.',
        coordinates: [121.32143932976706, 13.164128472005663]
    },
    {
        id: 'simbahang-bato',
        highlights: 'Enchanting 17th-century coral-stone ruins featuring a dramatic, historical "church within a church."',
        uniqueHighlight: 'Step into a captivating piece of history with a rare, picturesque inner-chapel built right into the heart of an ancient stone fortress.',
        name: 'Simbahang Bato (Bancuro Ruins)',
        category: 'Heritage',
        image: '/images/simbahan/main.jpg',
        desc: 'Step back in time at this hauntingly beautiful 17th-century relic. Originally built as a stone fortress against raids, these moss-draped coral and adobe ruins now cradle a rare "church within a church," offering a deeply atmospheric and picturesque glimpse into Spanish-era history.',
        coordinates: [121.32184698287517, 13.281370180034118],
        gallery: ['/images/simbahan/1.jpg']
    },
    {
        id: 'liwasang-bonifacio',
        highlights: 'The lively, green heart of Naujan, perfect for leisurely strolls and vibrant community festivals.',
        uniqueHighlight: 'Naujan’s vibrant "living room," seamlessly blending lively cultural shows, civic events, and laid-back everyday local life.',
        name: 'Liwasang Bonifacio',
        category: 'Cultural',
        image: '/images/liwasang.jpg',
        desc: 'Feel the pulse of Naujan at its vibrant town plaza. Surrounded by manicured greenery, this inviting open space is the perfect backdrop for leisurely afternoon strolls, lively community festivals, and experiencing the warm, everyday charm of local life.',
        coordinates: [121.3030, 13.3242]
    },
    {
        id: 'dao-waterlily-minipark',
        highlights: 'A highly photogenic eco-park blending scenic boat rides with inspiring, sustainable local craftsmanship.',
        uniqueHighlight: 'Drift through stunning lily-covered waterways and discover how the community transforms these blooms into gorgeous, eco-chic fashion.',
        name: 'Dao Waterlily Minipark',
        category: 'Nature',
        image: '/images/waterlily/main.jpg',
        desc: 'Glide through a vibrant carpet of blooming water lilies at this picturesque eco-park. Beyond the incredibly scenic boat rides, you will discover an inspiring community hub where local artisans transform humble lily stalks into beautiful, sustainable eco-fashion.',
        coordinates: [121.31942065376933, 13.2567513208881],
        gallery: ['/images/waterlily/1.jpg', '/images/waterlily/2.jpg', '/images/waterlily/3.jpg']
    },
    {
        id: 'montelago-hot-spring',
        highlights: 'A soothing sanctuary of therapeutic, warm mineral pools and refreshing forest falls.',
        uniqueHighlight: 'The ultimate relaxation hub that pairs soothing geothermal hot springs with a stunning forest waterfall, all accessed via a scenic trek.',
        name: 'Montelago Hot Spring & Forest Falls',
        category: 'Nature',
        image: '/images/hotspring/main.jpg',
        desc: 'Melt your stress away in therapeutic, warm mineral pools nestled deeply within the region\'s geothermal veins. This hidden sanctuary perfectly balances relaxation and adventure, featuring refreshing forest falls and trails that reveal the rugged volcanic beauty of the lake\'s shoreline.',
        coordinates: [121.37576057128022, 13.222410474261634],
        gallery: ['/images/hotspring/1.jpg']
    },
    {
        id: 'agrigold-farm',
        highlights: 'An inspiring, certified learning farm offering hands-on experiences in sustainable and organic agriculture.',
        uniqueHighlight: 'Roll up your sleeves and "learn in the field" at this accredited, highly interactive farm celebrating modern organic practices.',
        name: 'AgriGold Farm Learning Center Inc.',
        category: 'Agri-Tourism',
        image: '/images/agrigold/main.jpg',
        desc: 'Get your hands dirty and your mind inspired at this vibrant educational sanctuary. Whether you are an aspiring farmer or an eco-enthusiast, you will love the immersive, hands-on workshops in sustainable agriculture and organic farming that empower the local community.',
        coordinates: [121.25798077115141, 13.2533426861691],
        gallery: ['/images/agrigold/1.jpg', '/images/agrigold/2.jpg', '/images/agrigold/3.jpg']
    },
    {
        id: 'celeste-beach-house',
        highlights: 'A serene, intimate beachfront retreat offering pure relaxation and direct access to calming sea waters.',
        uniqueHighlight: 'Experience the ultimate "home-away-from-home" vibe where the shoreline is practically at your doorstep.',
        name: 'Celeste Beach House',
        category: 'Resort',
        image: '/images/celeste/main.jpg',
        desc: 'Trade crowded resorts for your own private slice of paradise at this intimate beachfront retreat. Offering a laid-back, "home-away-from-home" vibe with the ocean just steps from your door, it is the ultimate seaside escape for quiet holidays and memorable family getaways.',
        coordinates: [121.31222816936804, 13.32851830943331],
        gallery: ['/images/celeste/1.jpg', '/images/celeste/2.jpg'],
        rooms: [
            { name: 'Duplex Guest Room', details: 'Good for 6, fan room', price: '₱800 / night', image: '/images/celeste/duplex.jpg' }
        ],
        facebook: 'https://web.facebook.com/profile.php?id=61573655720760',
        openingHours: 'Check-in: 2:00 PM | Check-out: 12:00 NN',
        entranceFees: 'Exclusive rental (Rates apply)',
        visitorTips: 'Bring your own snorkeling gear! The waters right in front of the house are incredibly clear.'
    },
    {
        id: 'largo-castillo-farm',
        highlights: 'A beautifully rustic, eco-conscious haven championing creative upcycling and sprawling green serenity.',
        uniqueHighlight: 'Every corner tells a story in this creatively upcycled paradise, offering a uniquely inspiring setting for peaceful farm-to-table moments.',
        name: 'Largo Castillo Farm House',
        category: 'Agri-Tourism',
        image: '/images/largo/main.jpg',
        desc: 'Experience the charm of sustainable living at this wonderfully rustic, eco-conscious farmhouse. Set amidst sprawling green fields, every corner showcases creative upcycling, providing a uniquely inspiring and peaceful backdrop for intimate celebrations and farm-to-table dining.',
        coordinates: [121.27758068131465, 13.333447596743362],
        gallery: ['/images/largo/1.jpg', '/images/largo/2.jpg', '/images/largo/3.jpg']
    },
    {
        id: 'nabul-beach-resort',
        highlights: 'A picture-perfect strip of native kubo cottages and crystal-clear waters for the ultimate laid-back beach day.',
        uniqueHighlight: 'Ditch the crowds for a classic, back-to-basics Filipino seaside picnic where calm, shallow waters are the main attraction.',
        name: 'Nabul Beach Resort',
        category: 'Resort',
        image: '/images/nabul/main.jpg',
        desc: 'Embrace the ultimate back-to-basics beach day at Nabul. With its classic native kubo cottages catching the gentle sea breeze and incredibly clear, shallow waters, it is the perfect spot for a carefree, traditional Filipino seaside picnic with family and friends.',
        coordinates: [121.34785867159911, 13.292433044845254],
        openingHours: '7:00 AM - 6:00 PM',
        entranceFees: '₱50 per head',
        visitorTips: 'Classic "probinsya" beach vibes! Best to bring your own packed lunch and rent a kubo.'
    },
    {
        id: 'villa-cornitz',
        highlights: 'Adrialuna’s hidden oasis, featuring pristine swimming pools and breezy open-air cabanas.',
        uniqueHighlight: 'The perfect intimately scaled resort, offering an exclusive, private-feel atmosphere ideal for memorable local celebrations.',
        name: 'Villa Cornitz Mini Resort',
        category: 'Resort',
        image: '/images/cornitz/1.jpg',
        desc: 'Uncover Adrialuna’s best-kept secret. This charming mini-resort offers an exclusive, intimate atmosphere with pristine swimming pools and breezy open-air cabanas—making it the ideal private oasis for memorable family reunions, birthdays, or a quick weekend plunge.',
        coordinates: [121.28569607104512, 13.212265618761423],
        gallery: ['/images/cornitz/1.jpg', '/images/cornitz/2.jpg', '/images/cornitz/3.jpg', '/images/cornitz/4.jpg'],
        openingHours: '8:00 AM - 10:00 PM',
        entranceFees: '₱100 Adult / ₱80 Kids',
        visitorTips: 'Great for private parties. Message them in advance to reserve a pavilion.'
    },
    {
        id: 'la-hacienda',
        highlights: 'A breathtaking Balinese-inspired oasis boasting lush tropical gardens, a stunning centerpiece pool, and elegant villas.',
        uniqueHighlight: 'Transport yourself to Bali right in the heart of Naujan with curated, highly photogenic tropical landscaping and luxurious themed villas.',
        name: 'La Hacienda',
        category: 'Resort',
        image: '/images/hacienda/main.jpg',
        desc: 'Escape to Bali without leaving Mindoro at this breathtaking private oasis. Featuring elegantly designed themed villas, lush tropical landscaping, and a stunning centerpiece pool, La Hacienda delivers a luxurious, highly photogenic retreat in the heart of the countryside.',
        coordinates: [121.30584297294946, 13.317016887351807],
        gallery: ['/images/hacienda/1.jpg', '/images/hacienda/2.jpg', '/images/hacienda/3.jpg', '/images/hacienda/4.jpg', '/images/hacienda/5.jpg'],
        openingHours: 'Check-in: 2:00 PM | Check-out: 12:00 NN',
        entranceFees: 'Overnight Rates Apply',
        visitorTips: 'Highly photogenic spot! Don’t forget to pack your best resort wear.'
    },
    {
        id: 'villa-catalina',
        highlights: 'A delightful fusion of vibrant farm charm and relaxing resort leisure for a picture-perfect family escape.',
        uniqueHighlight: 'Enjoy the best of both worlds: immerse yourself in beautiful harvest views by day and unwind with top-tier resort comfort by night.',
        name: 'Villa Catalina Eco Farm Resort',
        category: 'Resort',
        image: '/images/catalina/main.jpg',
        desc: 'Experience the best of both worlds where vibrant farm life meets resort-style relaxation. Villa Catalina offers a wholesome, family-friendly escape where you can explore lush agricultural surroundings by day and unwind in ultimate comfort by night.',
        coordinates: [121.27171983311774, 13.309237043724876],
        gallery: ['/images/catalina/1.jpg', '/images/catalina/2.jpg'],
        facebook: 'https://web.facebook.com/VillaCatalinaEcoFarmResort',
        openingHours: '7:00 AM - 8:00 PM',
        entranceFees: '₱150 per head (Day Tour)',
        visitorTips: 'Explore the agricultural areas in the early morning for the best weather and views.'
    },
    {
        id: 'benilda-ng-bancuro',
        highlights: 'An action-packed family paradise featuring thrilling pool slides, a magical butterfly sanctuary, and horseback riding.',
        uniqueHighlight: 'The ultimate all-in-one family playland where you can swim, ride, explore nature, and dine—all in one vibrant destination.',
        name: 'Benilda ng Bancuro Resort & Restaurant',
        category: 'Resort',
        image: '/images/benilda.jpg',
        desc: 'Dive into endless fun at Naujan\'s ultimate family playground. From thrilling slide-equipped pools and a mesmerizing butterfly sanctuary to horseback riding adventures, this sprawling resort guarantees an action-packed, unforgettable day out for all ages.',
        coordinates: [121.3225, 13.2795],
        facebook: 'https://web.facebook.com/BenildaResort',
        openingHours: '8:00 AM - 6:00 PM',
        entranceFees: '₱150 Adult / ₱100 Kids',
        visitorTips: 'Make sure to check out the butterfly sanctuary before getting wet in the pools.'
    },
    {
        id: '333-steps',
        highlights: 'An exhilarating 333-step ascent rewarding you with spellbinding, panoramic views of the lush Melgar landscape.',
        uniqueHighlight: 'A beautiful blend of fitness and scenic wonder, ending at a dramatic view deck that promises unforgettable sunrise and sunset reflections.',
        name: '333 Steps (Melgar A)',
        category: 'Nature',
        image: '/images/333-steps.jpg',
        desc: 'Challenge yourself to a rewarding climb where faith meets fitness. Ascend 333 steps through lush greenery to reach a stunning hilltop viewing deck, rewarding your effort with a spellbinding, panoramic sweep of the rolling Melgar landscape and the sparkling coast.',
        coordinates: [121.35578622557868, 13.275250119249757]
    },
    {
        id: 'naujan-agri-center',
        highlights: 'The dynamic heart of Naujan’s agricultural innovation, showcasing modern farming research and practices.',
        uniqueHighlight: 'Get an exclusive, behind-the-scenes look at the thriving demo farms and nurseries that power Naujan’s rich agricultural heritage.',
        name: 'Naujan Agricultural Center',
        category: 'Agri-Tourism',
        image: '/images/naujan-agri.jpg',
        desc: 'Discover the roots of Naujan\'s rich farming heritage at this dynamic agricultural hub. Get a fascinating behind-the-scenes look at sustainable food production, vibrant demo farms, and the innovative programs driving the town\'s local farming community forward.',
        coordinates: [121.3005, 13.3230]
    },
    {
        id: 'hafa-adai',
        highlights: 'A blissful seaside dining spot serving mouth-watering local delicacies against an unobstructed ocean horizon.',
        uniqueHighlight: 'Your ultimate coastal lounge—enjoy incredible drinks and eats while the crashing waves and sea breeze provide the perfect natural soundtrack.',
        name: 'Hafa Adai',
        category: 'Resort',
        image: '/images/hafa-adai.jpg',
        desc: 'Savor the ultimate seaside chill at Hafa Adai. Enjoy an unforgettable dining experience where you can feast on delicious local delicacies and cold drinks, all while soaking in an unobstructed, horizon-stretching view of the sea accompanied by a soothing ocean breeze.',
        coordinates: [121.31022214428944, 13.331900799869143]
    },
    {
        id: 'emerald-resort',
        highlights: 'A spacious, tranquil beachfront sanctuary perfectly situated on the pristine Brgy. Estrella shoreline.',
        uniqueHighlight: 'The ultimate crowd-pleaser, offering an expansive beachfront and roomy quarters designed to perfectly host large clans and barkadas.',
        name: 'Emerald Resort',
        category: 'Resort',
        image: '/images/emerald.jpg',
        desc: 'Gather the whole gang for an unforgettable coastal getaway. Boasting a remarkably wide, pristine beachfront and exceptionally spacious accommodations, Emerald Resort is the perfect sanctuary for large families and barkadas craving a peaceful, crowd-free oceanfront escape.',
        coordinates: [121.3134430221171, 13.323650337442288],
        openingHours: '8:00 AM - 5:00 PM',
        entranceFees: '₱50 per head',
        visitorTips: 'Spacious beachfront! Bring volleyballs and frisbees for group games.'
    },
    {
        id: 'mulawin-boulevard',
        highlights: 'A scenic, tree-lined thoroughfare that beautifully captures the vibrant, modern growth of Naujan.',
        uniqueHighlight: 'A captivating cityscape viewpoint that frames Naujan’s exciting urban development against beautiful, leafy roadside trees.',
        name: 'Mulawin Boulevard',
        category: 'Landmark',
        image: '/images/mulawin.jpg',
        desc: 'Take a scenic drive down Mulawin Boulevard, the dynamic artery connecting Naujan\'s vibrant neighborhoods. Framed by roadside trees, this bustling thoroughfare offers a captivating, everyday glimpse into the town\'s steady growth and welcoming local spirit.',
        coordinates: [121.13913740674923, 13.236412504363686]
    },
    {
        id: 'mais-place',
        highlights: 'A pristine, modern private pool and cozy dining space crafted for the ultimate exclusive staycation.',
        uniqueHighlight: 'Your personal luxury hideaway—enjoy an entire premium pool and dining space completely exclusive to your closest group.',
        name: 'Mai’s Place Private Pool',
        category: 'Resort',
        image: '/images/mai/main.jpg',
        desc: 'Claim your own private paradise for the day at Mai’s Place. Featuring a pristine, modern swimming pool and a cozy dining area completely exclusive to your group, it is the ultimate premium staycation spot for intimate celebrations and undisturbed relaxation.',
        coordinates: [121.312303, 13.31945],
        gallery: ['/images/mai/1.jpg', '/images/mai/2.jpg', '/images/mai/3.jpg', '/images/mai/4.jpg', '/images/mai/5.jpg'],
        facebook: 'https://web.facebook.com/profile.php?id=100075758085120',
        openingHours: 'Always Open',
        phone: '0927 906 0728',
        entranceFees: 'Message FB page for more information'
    },
    {
        id: 'rio-del-sierra',
        highlights: 'A breathtaking, off-grid riverside sanctuary enveloped by majestic mountains and icy, refreshing waters.',
        uniqueHighlight: 'Escape the concrete jungle for a wildly beautiful, off-grid experience featuring raw nature, rustic kubos, and towering forested walls.',
        name: 'Rio del Sierra',
        category: 'Nature',
        image: '/images/rio-del-sierra.jpg',
        desc: 'Disconnect from the grid and reconnect with nature at this raw, hidden riverside sanctuary. Flanked by majestic mountain walls, you can lounge in rustic kubo huts and plunge into crystal-clear, ice-cold river waters for a truly refreshing and wild escape.',
        coordinates: [121.08257645610377, 13.275679230651638]
    },
    {
        id: 'organic-healing-park',
        highlights: 'A transformative wellness destination dedicated to a chemical-free, healing lifestyle and slow living.',
        uniqueHighlight: 'Hit the reset button with farm-fresh organic food, tranquil spaces, and deeply grounding holistic activities designed to recharge your soul.',
        name: 'DJMV Organic Healing Park',
        category: 'Agri-Tourism',
        image: '/images/djmv/main.jpg',
        desc: 'Hit the reset button on your mind and body at this holistic wellness haven. Championing a chemical-free, slow-living lifestyle, the park invites you to heal and recharge through farm-fresh food, tranquil spaces, and deeply grounding eco-friendly activities.',
        coordinates: [121.26191557028895, 13.257723450711651],
        gallery: ['/images/djmv/1.jpg', '/images/djmv/2.jpg', '/images/djmv/3.jpg', '/images/djmv/4.jpg'],
        facebook: 'https://web.facebook.com/djmvfarm1960',
        phone: '0995 154 1359',
        email: 'djmvfarm12@gmail.com',
        openingHours: '08:00 - 17:00 Weekdays / 09:00 - 17:00 Weekends'
    },
    {
        id: 'villa-valerie',
        highlights: 'A beloved local cornerstone famous for its massive swimming pools and famously warm, inviting atmosphere.',
        uniqueHighlight: 'Naujan’s classic, nostalgic resort destination—the ultimate multi-generational gathering spot filled with joyful community memories.',
        name: 'Villa Valerie Resort',
        category: 'Resort',
        image: '/images/valerie/main.jpg',
        desc: 'Create new memories at the classic Naujan resort locals have loved for generations. Known for its massive, inviting swimming pools and famously warm hospitality, Villa Valerie remains the undisputed go-to destination for joyful family gatherings and weekend fun.',
        gallery: ['/images/valerie/1.jpg', '/images/valerie/2.jpg'],
        coordinates: [121.30551630916001, 13.273115341550229],
        facebook: 'https://web.facebook.com/profile.php?id=100083105421531',
        openingHours: '08:00 - 17:00',
        entranceFees: '₱75 3-7yrs old / ₱150.00 8-59yrs old / ₱130.00 Senior Citizen',
        visitorTips: 'It gets quite popular on weekends, so arrive early to secure a good cottage!',
        rooms: [
            { name: 'Family Room', details: '10 - 12 packs', price: '₱6,000.00 / 2pm - 11am', image: '' },
            { name: 'Standard Room', details: '2 packs', price: '₱2,000.00 / 2pm - 11am', image: '' },
            { name: 'Extra Bed', details: 'If the bed is not enough', price: '₱250.00', image: '' }
        ],
        addons: [
            { name: 'Videoke Rent', details: '', price: '₱500.00' },
            { name: 'Billiards', details: '', price: '₱100.00 / hour' },
            { name: 'Bangka', details: '', price: '₱100.00 / hour' },
            { name: 'Ihawan', details: '', price: '₱100.00 charge' },
            { name: 'Liquor Corkage', details: '', price: '₱500.00' },
            { name: 'Day Time Swimming', details: '8:00 AM to 5:00 PM only', price: '' },
            { name: 'Overtime Swimming', details: "Until 8:00 PM", price: 'Kids: ₱25.00 \n Adult: ₱50.00' },
            { name: 'Night Swimming', details: '4:00 PM - 9:00 PM', price: 'Kids: ₱100.00 \n Adult: ₱200.00' }
        ]
    },
    {
        id: 'karacha-falls',
        highlights: 'A majestic, dramatic single-drop waterfall featuring powerful cascades and a crystal-clear forest pool.',
        uniqueHighlight: 'The ultimate reward for off-road adventurers: an awe-inspiring hidden cascade plunging into a deep, swimmable, icy basin.',
        name: 'Karacha Falls',
        category: 'Nature',
        image: '/images/karacha/main.jpg',
        desc: 'Embark on an off-road adventure to discover one of Naujan\'s most dramatic natural wonders. Hidden deep within the forest, this towering, single-drop waterfall rewards daring explorers with a spectacular cascade and a deep, icy basin perfect for a wild, refreshing swim.',
        coordinates: [121.15033698134432, 13.18974045547888],
        gallery: ['/images/karacha/1.jpg', '/images/karacha/2.jpg', '/images/karacha/3.jpg', '/images/karacha/4.jpg']
    },
    {
        id: 'oric-sa-bathala',
        highlights: 'An exciting eco-tourism gem featuring a thrilling hanging bridge, horseback rides, and stunning hidden falls.',
        uniqueHighlight: 'A spectacular mini-adventure circuit: conquer a swinging bridge, ride through nature, and cool off under breathtaking waterfalls in one epic trip.',
        name: 'ORIC sa Bathala Waterfalls',
        category: 'Nature',
        image: '/images/bathala/main.jpg',
        desc: 'Answer the call of adventure at this thrilling, up-and-coming eco-tourism hotspot. Test your nerves on a suspended hanging bridge, enjoy a scenic horseback ride, and cap it all off with a cool, well-deserved dip at the stunning hidden waterfalls.',
        coordinates: [121.32986053347372, 13.249813090109098],
        gallery: ['/images/bathala/1.jpg']
    },
    {
        id: 'la-familia-cortijo',
        highlights: 'A highly sophisticated, elegantly rustic venue set amidst exquisitely landscaped gardens and farm views.',
        uniqueHighlight: 'The premier destination for fairytale garden weddings, blending stunning styled architecture with the enchanting backdrop of a working calamansi farm.',
        name: 'La Familia Cortijo & Event Place',
        category: 'Event-Place',
        image: '/images/cortijo/main.jpg',
        desc: 'Celebrate your biggest moments in absolute style at this sophisticated farm venue. Seamlessly blending rustic architectural elegance with perfectly manicured gardens against a working calamansi farm backdrop, it is the premier setting for unforgettable garden weddings and grand events.',
        coordinates: [121.29332313907008, 13.31360065147099],
        gallery: ['/images/cortijo/1.jpg', '/images/cortijo/2.jpg', '/images/cortijo/3.jpg', '/images/cortijo/4.jpg'],
        rent: [
            { name: 'Rent', details: 'Rent the whole area', price: 'Contact them using the links', image: '/images/cortijo/offer.jpg' }
        ],
        facebook: 'https://web.facebook.com/pinoyfleamarket',
        phone: '0966-251-0050',
        openingHours: 'Always Open'
    },
    {
        id: 'darie-tambayan',
        highlights: 'A friendly, highly convenient road-trip haven offering spotlessly clean and comfortable accommodations.',
        uniqueHighlight: 'The ultimate traveler\'s pitstop right on the highway—perfectly positioned for a quick, exceptionally comfortable recharge during your Mindoro journey.',
        name: 'Darie Tambayan Hotel',
        category: 'Accommodation',
        image: '/images/darie/main.jpg',
        desc: 'Hit the brakes and rest easy at the ultimate road-tripper\'s pitstop. Conveniently located right on the Nautical Highway, Darie Tambayan offers spotlessly clean, comfortable rooms and incredibly friendly service to recharge weary travelers exploring the beauty of Mindoro.',
        coordinates: [121.24395862557884, 13.27465704490922],
        gallery: ['/images/darie/1.jpg', '/images/darie/2.jpg', '/images/darie/3.jpg', '/images/darie/4.jpg'],
        rooms: [
            { name: 'Couple Room', details: 'Good for 2, Free Wifi/Airconditioned, TV Available Netflix and Youtube', price: '₱1,200 / 12hrs', image: '/images/darie/couple.jpg' },
            { name: 'Family/Barkada Room', details: 'Good for 4, air-conditioned', price: '₱1,500 / 12hrs \n ₱2,500 / 24hrs', image: '/images/darie/family.jpg' }
        ],
        facebook: 'https://web.facebook.com/darietambayanhotel',
        phone: '0945 380 9638',
        openingHours: '24/7 Front Desk',
        entranceFees: 'N/A (Room Rates Apply)',
        visitorTips: 'Right along the highway—an easy, hassle-free spot to recharge during a long road trip.'
    },
    {
        id: 'el-caviteno',
        highlights: 'An incredibly affordable, centrally located apartelle serving as the perfect launchpad for backpackers.',
        uniqueHighlight: 'Your ideal, budget-friendly "basecamp" in Estrella, making beach-hopping and exploring local town spots an absolute breeze.',
        name: 'El Caviteño Apartelle',
        category: 'Accommodation',
        image: '/images/el-caviteno.jpg',
        desc: 'Drop your bags and start exploring from this highly convenient backpacker\'s basecamp. Offering superb affordability right in the heart of Brgy. Estrella, it places you just moments away from sun-kissed beaches and Naujan\'s best local landmarks.',
        coordinates: [121.31352692293383, 13.324207214721454],
        rooms: [
            { name: 'Studio Unit', details: 'With kitchenette', price: '₱1,200 / night' },
            { name: 'Family Suite', details: 'Good for 5–6 pax', price: '₱2,000 / night' }
        ]
    },
    {
        id: 'naujan-travellers-inn',
        highlights: 'A beloved, budget-friendly inn famous for its incredibly popular in-house restobar and hearty Filipino fare.',
        uniqueHighlight: 'The ultimate dine-and-rest combo—enjoy generous, unli-style meals downstairs and crash in absolute comfort upstairs.',
        name: 'Naujan Traveller’s Inn and Resto Bar',
        category: 'Accommodation',
        image: '/images/inn/main.jpg',
        desc: 'Treat yourself to a fantastic night\'s sleep and an even better meal. This beloved highway haven pairs budget-friendly, comfortable rooms with an incredibly popular restobar downstairs, serving up mouth-watering, unli-style Filipino comfort food and ice-cold drinks.',
        coordinates: [121.24275524252755, 13.274613101398995],
        gallery: ['/images/inn/1.jpg', '/images/inn/2.jpg', '/images/inn/3.jpg'],
        rooms: [
            { name: 'Casual Room', details: 'With breakfast, lunch, meal. Free Wifi, unli rice', price: '₱1,800 \n ₱2,300 \n ₱2,600', image: '/images/inn/1.jpg' }
        ],
        menu: [
            { name: 'Mixed Seafoods W/ Unli Rice, Juice', details: 'Unli seafood', price: '₱199 \n ₱299 \n ₱399', image: '/images/inn/puds.jpg' }
        ],
        facebook: 'https://web.facebook.com/NaujanTravellersInn',
        openingHours: '24/7 Front Desk',
        entranceFees: 'N/A (Room rates apply)',
        visitorTips: 'You absolutely cannot miss their unli-rice seafood meals downstairs.'
    },
    {
        id: 'bahay-tuklasan-hall',
        highlights: 'A dynamic, state-of-the-art plenary hall hosting high-energy agricultural congresses and regional events.',
        uniqueHighlight: 'The powerful "thinking hub" of Naujan, shaping the community\'s future through vital agricultural and civic collaborations.',
        name: 'Bahay Tuklasan Plenary Hall',
        category: 'Event-Place',
        image: '/images/bahay-tuklasan-hall.jpg',
        desc: 'Step inside the intellectual hub of Naujan. This dynamic plenary hall is where the community\'s future is shaped, regularly hosting high-energy agricultural congresses, crucial training sessions, and key local events that drive the region forward.',
        coordinates: [121.30076869567007, 13.319883003820582]
    },
    {
        id: 'bahay-tuklasan-dorm',
        highlights: 'A clean, vibrant, and highly practical communal living space tailored for large groups and student trips.',
        uniqueHighlight: 'Purpose-built for camaraderie and convenience, offering the perfect budget-friendly base right next to Naujan’s top training facilities.',
        name: 'Bahay Tuklasan Dormitory',
        category: 'Accommodation',
        image: '/images/dorm/main.jpg',
        desc: 'Find comfort and camaraderie at this incredibly practical, budget-friendly dormitory. Purpose-built for large groups, students, and training attendees, it offers clean, communal living spaces perfectly situated next to the town\'s top agricultural and training facilities.',
        coordinates: [121.30076869567007, 13.319883003820582],
        gallery: ['/images/dorm/1.jpg', '/images/dorm/2.jpg'],
        rooms: [
            { name: 'Dorm Bed', details: 'Shared room, fan', price: '₱5,000 / night', image: '/images/dorm/1.jpg' }
        ]
    },
    {
        id: 'balay-murraya',
        highlights: 'An impeccably stylish, highly Instagrammable homestay wrapped in the tranquil embrace of surrounding farms.',
        uniqueHighlight: 'Masterfully balances chic, modern interior design with the deep, grounding peace of authentic "probinsya" farm life.',
        name: 'Balay Murraya',
        category: 'Accommodation',
        image: '/images/balai/main.jpg',
        desc: 'Immerse yourself in ‘probinsya’ peace without sacrificing modern style. Surrounded by quiet farms, this highly Instagrammable homestay features thoughtfully curated rooms and exceptional local hospitality, providing a wonderfully chic and cozy base for your Naujan adventures.',
        coordinates: [121.27171220105949, 13.271838002910227],
        gallery: ['/images/balai/1.jpg', '/images/balai/2.jpg', '/images/balai/3.jpg', '/images/balai/4.jpg'],
        facebook: 'https://www.facebook.com/profile.php?id=61566762603706',
        email: 'balaymurraya.ph@gmail.com',
        phone: '+63 915 934 7458',
        rooms: [{ name: 'Silid Bangka', details: 'max 8 adults', price: 'Go to Balay Murraya FB page' },
        { name: 'Silid Lakatan', details: 'max 4 adults', price: 'Go to Balay Murraya FB page' },
        { name: 'Silid Palmera', details: 'max 4 adults', price: 'Go to Balay Murraya FB page' }
        ],
        openingHours: '21:00 - 18:00 Everyday'
    },
    {
        id: 'bistro-amparo',
        name: 'Bistro Amparo',
        category: 'Food / Resto',
        image: "/images/bistro/main.jpg",
        coordinates: [121.22478519996423, 13.276361916243165],
        facebook: "https://www.facebook.com/BistroAmparo",
        openingHours: '10:00 - 20:00',
        gallery: ['/images/bistro/1.JPG', '/images/bistro/2.JPG']
    },
    {
        id: 'EUT',
        name: 'Eat, Unwind, Tea (EUT)',
        category: 'Food / Resto',
        image: "/images/eut/main.jpg",
        coordinates: [121.30076869567007, 13.319883003820582],
    },
    {
        id: 'big-brew',
        name: 'Big Brew',
        category: 'Food / Resto',
        image: "/images/big-brew/main.jpg",
        coordinates: [121.30270306499425, 13.323418453468708],
        facebook: "https://www.facebook.com/profile.php?id=61552072790649",
        openingHours: '10:00 - 20:00',
        email: 'bigbrewnaujan@gmail.com',
        phone: '0912 567 4719'
    },
    {
        id: 'sizzling',
        name: 'Sizzling',
        category: 'Food / Resto',
        image: "/images/sizzling/main.jpg",
        coordinates: [121.30076869567007, 13.319883003820582],
    },
    {
        id: 'suarez-farm',
        name: 'Suarez Farm',
        category: 'Food / Resto',
        image: "/images/suarez/main.jpg",
        coordinates: [121.28404673658255, 13.327410188001998],
        facebook: "https://www.facebook.com/SuarezFarms",
        openingHours: '10:00 - 21:00',
        email: "suarezfarmz.agri@gmail.com"
    },
    {
        id: 'melbourne-lomi-house',
        name: 'Melbourne Lomi House',
        category: 'Food / Resto',
        image: "/images/melbourne/main.jpg",
        coordinates: [121.30076869567007, 13.319883003820582],
    }
];
loadAttractions();

// --- Weather API integration (WeatherAPI.com) ---
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'dbeefc9785684901b0c32744260303';
const WEATHER_API_BASE = 'https://api.weatherapi.com/v1';

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, res => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            return reject(new Error(json.error.message || 'Weather API error'));
                        }
                        resolve(json);
                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .on('error', reject);
    });
}

async function getWeatherForAttraction(attraction) {
    if (!WEATHER_API_KEY || !attraction || !attraction.coordinates) {
        return null;
    }

    const [lng, lat] = attraction.coordinates;
    const query = encodeURIComponent(`${lat},${lng}`);
    const url = `${WEATHER_API_BASE}/forecast.json?key=${WEATHER_API_KEY}&q=${query}&days=3&aqi=no&alerts=no`;

    try {
        const json = await httpGetJson(url);
        const current = json.current || {};
        const today = (json.forecast && json.forecast.forecastday && json.forecast.forecastday[0]) || {};
        const hours = today.hour || [];

        const bestTime = computeBestVisitTime(hours);

        const forecastDays = (json.forecast && json.forecast.forecastday) ? json.forecast.forecastday.map(day => {
            const dateObj = new Date(day.date);
            const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
            return {
                date: dayName,
                icon: `https:${day.day.condition.icon}`,
                maxTemp: Math.round(day.day.maxtemp_c),
                minTemp: Math.round(day.day.mintemp_c)
            };
        }) : [];

        return {
            locationName: json.location ? json.location.name : 'Naujan',
            conditionText: current.condition ? current.condition.text : null,
            icon: current.condition ? `https:${current.condition.icon}` : null,
            tempC: current.temp_c,
            feelsLikeC: current.feelslike_c,
            chanceOfRain: current.chance_of_rain || (today.day && today.day.daily_chance_of_rain),
            bestTimeLabel: bestTime.label,
            bestTimeDetail: bestTime.detail,
            forecastDays: forecastDays
        };
    } catch (err) {
        console.warn('Failed to fetch weather:', err.message);
        return null;
    }
}

function computeBestVisitTime(hours) {
    if (!Array.isArray(hours) || hours.length === 0) {
        return {
            label: 'Anytime today',
            detail: 'Weather details are temporarily unavailable. Plan your visit according to your preferred schedule.'
        };
    }

    const daytime = hours.filter(h => {
        const hour = new Date(h.time).getHours();
        return hour >= 6 && hour <= 18;
    });

    const isGoodHour = h => {
        const text = (h.condition && h.condition.text || '').toLowerCase();
        const notRainy = !text.includes('rain') && !text.includes('thunder') && !text.includes('storm');
        const comfortableTemp = typeof h.temp_c === 'number' ? h.temp_c >= 23 && h.temp_c <= 32 : true;
        const uvOk = typeof h.uv === 'number' ? h.uv <= 9 : true;
        return notRainy && comfortableTemp && uvOk;
    };

    const good = (daytime.length ? daytime : hours).filter(isGoodHour);

    if (!good.length) {
        return {
            label: 'Plan flexibly today',
            detail: 'There may be heat, rain, or storms today. Consider indoor activities or check the sky before heading out.'
        };
    }

    const first = good[0];
    const last = good[good.length - 1];

    const formatTime = h => {
        const d = new Date(h.time);
        let hr = d.getHours();
        const ampm = hr >= 12 ? 'PM' : 'AM';
        hr = hr % 12 || 12;
        return `${hr} ${ampm}`;
    };

    const windowText = first.time === last.time
        ? formatTime(first)
        : `${formatTime(first)} – ${formatTime(last)}`;

    let label = 'Best hours today';
    const firstHour = new Date(first.time).getHours();
    if (firstHour < 9) label = 'Best in the morning';
    else if (firstHour < 15) label = 'Best in the afternoon';
    else label = 'Best in the late afternoon';

    return {
        label,
        detail: `Weather looks most comfortable around ${windowText} based on today’s forecast.`
    };
}

app.get('/', (req, res) => {
    const active = getActiveAttractions();
    const topByVisits = getAttractionsWithVisits().filter(a => a.active !== false).slice(0, 3);
    res.render('index', {
        title: 'Visit Naujan - Oriental Mindoro',
        featured: topByVisits.length ? topByVisits : active.slice(0, 3),
        contactSuccess: req.query.success === 'contact_sent',
        contactError: req.query.error === 'contact_failed'
    });
});

app.post('/contact', async (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name).trim() : '';
    const email = (req.body && req.body.email) ? String(req.body.email).trim() : '';
    const subject = (req.body && req.body.subject) ? String(req.body.subject).trim() : '';
    const message = (req.body && req.body.message) ? String(req.body.message).trim() : '';

    if (!name || !email || !message) {
        return res.redirect('/?error=contact_failed#contact');
    }

    try {
        await sendContactEmail(name, email, subject, message);
        return res.redirect('/?success=contact_sent#contact');
    } catch (err) {
        console.warn('Contact form send failed:', err.message);
        return res.redirect('/?error=contact_failed#contact');
    }
});

app.get('/search', (req, res) => {
    const rawQuery = (req.query.q || '').trim();
    if (!rawQuery) {
        return res.redirect('/explore');
    }
    const searchQuery = rawQuery.toLowerCase();

    const active = getActiveAttractions();
    const searchResults = active.filter(spot =>
        (spot.name && spot.name.toLowerCase().includes(searchQuery)) ||
        (spot.category && spot.category.toLowerCase().includes(searchQuery)) ||
        (spot.desc && spot.desc.toLowerCase().includes(searchQuery))
    ).map(a => ({ ...a, stats: getAttractionStats(a.id) }));

    res.render('explore', {
        title: `Search Results for "${rawQuery}"`,
        attractions: searchResults,
        categories: categoriesList
    });
});

app.get('/api/search', (req, res) => {
    const searchQuery = (req.query.q || '').toLowerCase();

    if (!searchQuery) {
        return res.json([]);
    }

    const active = getActiveAttractions();
    const searchResults = active.filter(spot =>
        (spot.name && spot.name.toLowerCase().includes(searchQuery)) ||
        (spot.category && spot.category.toLowerCase().includes(searchQuery))
    ).map(a => ({ ...a, stats: getAttractionStats(a.id) })).slice(0, 5);

    res.json(searchResults);
});

app.get('/explore', (req, res) => {
    const active = getActiveAttractions();
    res.render('explore', {
        title: 'Explore Naujan',
        attractions: active.map(a => ({ ...a, stats: getAttractionStats(a.id) })),
        categories: categoriesList
    });
});

app.get('/map', (req, res) => {
    const active = getActiveAttractions();
    res.render('map', {
        title: 'Weather Map - Visit Naujan',
        attractions: active.map(a => ({ ...a, stats: getAttractionStats(a.id) }))
    });
});

app.get('/api/weather/:id', async (req, res) => {
    const attraction = getAttractionsSource().find(a => a.id === req.params.id);
    if (!attraction) {
        return res.status(404).json({ error: 'Attraction not found' });
    }
    const weather = await getWeatherForAttraction(attraction);
    res.json(weather || { error: 'Weather unavailable' });
});

app.get('/api/weather/coords/:lat/:lng', async (req, res) => {
    const lat = parseFloat(req.params.lat);
    const lng = parseFloat(req.params.lng);

    const customLocation = { coordinates: [lng, lat] };

    const weather = await getWeatherForAttraction(customLocation);
    res.json(weather || { error: 'Weather unavailable' });
});

app.get('/attraction/:id', async (req, res) => {
    const attraction = getAttractionsSource().find(a => a.id === req.params.id);

    if (!attraction || attraction.active === false) {
        return res.status(404).render('404', { title: 'Not Found' });
    }

    await recordVisit(req.params.id);

    const weather = await getWeatherForAttraction(attraction);
    const stats = getAttractionStats(attraction.id);
    const reviews = await getReviewsForAttraction(attraction.id);

    res.render('attraction', {
        title: `${attraction.name} - Visit Naujan`,
        attraction: attraction,
        mapboxToken: process.env.MAPBOX_ACCESS_TOKEN || '',
        weather,
        stats,
        reviews: reviews || []
    });
});

app.get('/api/reviews/:attractionId', async (req, res) => {
    const attraction = getAttractionsSource().find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });
    const reviews = await getReviewsForAttraction(req.params.attractionId);
    res.json(reviews);
});

app.post('/api/reviews/:attractionId', async (req, res) => {
    const userId = req.session && req.session.userId;
    const userEmail = req.session && req.session.email;
    const userName = req.session && req.session.name;
    if (!userId || !userEmail) return res.status(401).json({ error: 'Log in to leave a review', loginRequired: true });

    const attraction = getAttractionsSource().find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    const text = (req.body && req.body.text) ? String(req.body.text).trim() : '';
    if (!text) return res.status(400).json({ error: 'Review text is required' });

    const review = await addReview(req.params.attractionId, text, userId, userEmail, userName);
    if (!review) return res.status(500).json({ error: 'Could not save review' });
    res.status(201).json(review);
});

app.delete('/api/reviews/:attractionId/:reviewId', async (req, res) => {
    const userId = req.session && req.session.userId;
    const isAdmin = req.session && req.session.role === ROLE_ADMIN;
    if (!userId) return res.status(401).json({ error: 'Log in to delete a review', loginRequired: true });

    const attraction = getAttractionsSource().find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    const ref = reviewsRef.child(req.params.attractionId).child(req.params.reviewId);
    const snapshot = await ref.once('value');
    const review = snapshot.val();
    if (!review) return res.status(404).json({ error: 'Review not found' });

    if (!isAdmin && review.userId !== userId) return res.status(403).json({ error: 'Not allowed' });
    await ref.remove();
    return res.json({ ok: true });
});

// Edit own review (owner only)
app.put('/api/reviews/:attractionId/:reviewId', async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Log in to edit a review', loginRequired: true });

    const attraction = attractions.find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    const ref = reviewsRef.child(req.params.attractionId).child(req.params.reviewId);
    const snapshot = await ref.once('value');
    const review = snapshot.val();
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.userId !== userId) return res.status(403).json({ error: 'You can only edit your own review' });

    const text = (req.body && req.body.text) ? String(req.body.text).trim() : '';
    if (!text) return res.status(400).json({ error: 'Review text is required' });

    const updatedAt = new Date().toISOString();
    await ref.update({ text, updatedAt });
    const updatedSnap = await ref.once('value');
    return res.json({ id: req.params.reviewId, ...updatedSnap.val(), text, updatedAt });
});

app.post('/api/reviews/:attractionId/:reviewId/react', async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Log in to react', loginRequired: true });

    const attraction = attractions.find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    const reviewRef = reviewsRef.child(req.params.attractionId).child(req.params.reviewId);
    const snapshot = await reviewRef.once('value');
    const review = snapshot.val();
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.userId === userId) return res.status(403).json({ error: 'Cannot react to your own review' });

    const reactionsUserRef = reviewRef.child('reactions').child(userId);
    const current = await reactionsUserRef.once('value');
    const hasReacted = !!current.val();
    const action = (req.body && req.body.action) ? String(req.body.action) : 'toggle';

    if (action === 'add' && !hasReacted) await reactionsUserRef.set(true);
    else if (action === 'remove' && hasReacted) await reactionsUserRef.remove();
    else if (action === 'toggle') {
        if (hasReacted) await reactionsUserRef.remove();
        else await reactionsUserRef.set(true);
    }

    const reactionsSnapshot = await reviewRef.child('reactions').once('value');
    const reactionsVal = reactionsSnapshot.val() || {};
    const count = Object.keys(reactionsVal).length;
    const reacted = !!reactionsVal[userId];
    return res.json({ count, reacted });
});

// React to a specific reply under a review
app.post('/api/reviews/:attractionId/:reviewId/replies/:replyId/react', async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Log in to react', loginRequired: true });

    const attraction = attractions.find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    const replyRef = reviewsRef
        .child(req.params.attractionId)
        .child(req.params.reviewId)
        .child('replies')
        .child(req.params.replyId);

    const snapshot = await replyRef.once('value');
    const reply = snapshot.val();
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (reply.userId === userId) return res.status(403).json({ error: 'Cannot react to your own reply' });

    const reactionsUserRef = replyRef.child('reactions').child(userId);
    const current = await reactionsUserRef.once('value');
    const hasReacted = !!current.val();
    const action = (req.body && req.body.action) ? String(req.body.action) : 'toggle';

    if (action === 'add' && !hasReacted) await reactionsUserRef.set(true);
    else if (action === 'remove' && hasReacted) await reactionsUserRef.remove();
    else if (action === 'toggle') {
        if (hasReacted) await reactionsUserRef.remove();
        else await reactionsUserRef.set(true);
    }

    const reactionsSnapshot = await replyRef.child('reactions').once('value');
    const reactionsVal = reactionsSnapshot.val() || {};
    const count = Object.keys(reactionsVal).length;
    const reacted = !!reactionsVal[userId];
    return res.json({ count, reacted });
});

// Edit own reply
app.put('/api/reviews/:attractionId/:reviewId/replies/:replyId', async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Log in to edit a reply', loginRequired: true });

    const attraction = attractions.find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    const replyRef = reviewsRef
        .child(req.params.attractionId)
        .child(req.params.reviewId)
        .child('replies')
        .child(req.params.replyId);

    const snapshot = await replyRef.once('value');
    const reply = snapshot.val();
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (reply.userId !== userId) return res.status(403).json({ error: 'You can only edit your own reply' });

    const text = (req.body && req.body.text) ? String(req.body.text).trim() : '';
    if (!text) return res.status(400).json({ error: 'Reply text is required' });

    const updatedAt = new Date().toISOString();
    await replyRef.update({ text, updatedAt });
    return res.json({
        id: req.params.replyId,
        ...reply,
        text,
        updatedAt,
        reviewId: req.params.reviewId
    });
});

// Add a reply to a review (or to another reply of that review)
app.post('/api/reviews/:attractionId/:reviewId/replies', async (req, res) => {
    const userId = req.session && req.session.userId;
    const userEmail = req.session && req.session.email;
    const userName = req.session && req.session.name;
    if (!userId || !userEmail) {
        return res.status(401).json({ error: 'Log in to reply to a review', loginRequired: true });
    }

    const attraction = attractions.find(a => a.id === req.params.attractionId);
    if (!attraction || attraction.active === false) {
        return res.status(404).json({ error: 'Not found' });
    }

    const reviewRef = reviewsRef.child(req.params.attractionId).child(req.params.reviewId);
    const reviewSnap = await reviewRef.once('value');
    if (!reviewSnap.exists()) {
        return res.status(404).json({ error: 'Review not found' });
    }

    const text = (req.body && req.body.text) ? String(req.body.text).trim() : '';
    if (!text) {
        return res.status(400).json({ error: 'Reply text is required' });
    }

    const parentReplyId = (req.body && req.body.parentReplyId) ? String(req.body.parentReplyId).trim() : null;

    const reply = await addReply(req.params.attractionId, req.params.reviewId, text, userId, userEmail, userName, parentReplyId);
    if (!reply) {
        return res.status(500).json({ error: 'Could not save reply' });
    }

    return res.status(201).json({
        ...reply,
        reviewId: req.params.reviewId
    });
});

// Report a review or reply
app.post('/api/reports', async (req, res) => {
    const userId = req.session && req.session.userId;
    const userEmail = req.session && req.session.email;
    const userName = req.session && req.session.name;
    if (!userId) return res.status(401).json({ error: 'Log in to report', loginRequired: true });

    const attractionId = (req.body && req.body.attractionId) ? String(req.body.attractionId).trim() : '';
    const reviewId = (req.body && req.body.reviewId) ? String(req.body.reviewId).trim() : '';
    const replyId = (req.body && req.body.replyId) ? String(req.body.replyId).trim() : null;
    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';

    if (!attractionId || !reviewId) return res.status(400).json({ error: 'attractionId and reviewId are required' });

    const attraction = attractions.find(a => a.id === attractionId);
    if (!attraction || attraction.active === false) return res.status(404).json({ error: 'Not found' });

    let commentText, commentAuthorUserId, commentAuthorEmail, commentAuthorName;

    if (replyId) {
        const replyRef = reviewsRef.child(attractionId).child(reviewId).child('replies').child(replyId);
        const replySnap = await replyRef.once('value');
        const reply = replySnap.val();
        if (!reply) return res.status(404).json({ error: 'Reply not found' });
        if (reply.userId === userId) return res.status(403).json({ error: 'You cannot report your own comment' });
        commentText = reply.text;
        commentAuthorUserId = reply.userId;
        commentAuthorEmail = reply.userEmail || '';
        commentAuthorName = reply.userName || commentAuthorEmail;
    } else {
        const reviewRef = reviewsRef.child(attractionId).child(reviewId);
        const reviewSnap = await reviewRef.once('value');
        const review = reviewSnap.val();
        if (!review) return res.status(404).json({ error: 'Review not found' });
        if (review.userId === userId) return res.status(403).json({ error: 'You cannot report your own comment' });
        commentText = review.text;
        commentAuthorUserId = review.userId;
        commentAuthorEmail = review.userEmail || '';
        commentAuthorName = review.userName || commentAuthorEmail;
    }

    const reportRef = reportsRef.push();
    const report = {
        attractionId,
        attractionName: attraction.name || attractionId,
        reviewId,
        replyId: replyId || null,
        commentText,
        commentAuthorUserId,
        commentAuthorEmail,
        commentAuthorName,
        reportedByUserId: userId,
        reportedByEmail: userEmail || '',
        reportedByName: userName || userEmail || '',
        reason: reason || null,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    await reportRef.set(report);
    return res.status(201).json({ id: reportRef.key, ...report });
});

app.post('/api/rate/:id', async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Login required to rate', loginRequired: true });

    const id = req.params.id;
    const attraction = attractions.find(a => a.id === id);
    if (!attraction) return res.status(404).json({ error: 'Not found' });

    const rating = parseInt(req.body.rating, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Invalid rating' });
    }

    if (!favData[id]) favData[id] = { favorites: 0, ratingSum: 0, ratingCount: 0, ratedBy: {} };
    if (!favData[id].ratedBy) favData[id].ratedBy = {};

    const previousRating = favData[id].ratedBy[userId];
    if (previousRating) {
        favData[id].ratingSum = favData[id].ratingSum - previousRating + rating;
    } else {
        favData[id].ratingSum += rating;
        favData[id].ratingCount += 1;
    }
    favData[id].ratedBy[userId] = rating;

    await saveFavs();
    res.json(getAttractionStats(id));
});

app.post('/api/favorite/:id', async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Login required to add favorites', loginRequired: true });

    const id = req.params.id;
    const attraction = attractions.find(a => a.id === id);
    if (!attraction) return res.status(404).json({ error: 'Not found' });

    const action = req.body.action === 'remove' ? 'remove' : 'add';

    if (!favData[id]) favData[id] = { favorites: 0, ratingSum: 0, ratingCount: 0, favoritedBy: {} };
    if (!favData[id].favoritedBy) favData[id].favoritedBy = {};

    if (action === 'add') {
        if (!favData[id].favoritedBy[userId]) {
            favData[id].favorites += 1;
            favData[id].favoritedBy[userId] = true;
        }
    } else if (action === 'remove') {
        if (favData[id].favoritedBy[userId]) {
            favData[id].favorites = Math.max(0, favData[id].favorites - 1);
            delete favData[id].favoritedBy[userId];
        }
    }

    await saveFavs();
    res.json(getAttractionStats(id));
});

// --- Auth routes: login, register, logout ---
function isAdminPath(path) {
    const p = (path || '').trim();
    return p === '/admin' || p === '/admin/' || p.startsWith('/admin/');
}

app.get('/login', (req, res) => {
    if (req.session && req.session.role === ROLE_ADMIN) return res.redirect('/admin/dashboard');
    const redirect = (req.query.redirect && typeof req.query.redirect === 'string') ? req.query.redirect : '/';
    res.render('login', {
        title: 'Login - Naujan Tourism',
        error: req.query.error,
        success: req.query.success,
        redirect
    });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    let redirectTo = (req.body && req.body.redirect) ? String(req.body.redirect) : '/';
    try {
        const user = await findUserByEmail(email);
        if (!user || !user.passwordHash) return res.redirect('/login?error=invalid&redirect=' + encodeURIComponent(redirectTo));
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return res.redirect('/login?error=invalid&redirect=' + encodeURIComponent(redirectTo));
        if (user.banned === true) return res.redirect('/login?error=banned&redirect=' + encodeURIComponent(redirectTo));
        const isAdmin = await isRole(user, ROLE_ADMIN);

        // Block login for newly created, unverified regular users
        if (!isAdmin && user.verified === false) {
            try {
                let token = user.verificationToken;
                let expires = user.verificationExpires;
                const now = Date.now();
                if (!token || !expires || expires <= now) {
                    token = crypto.randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');
                    expires = now + VERIFICATION_TOKEN_TTL_MS;
                    await usersRef.child(user.uid).update({
                        verificationToken: token,
                        verificationExpires: expires
                    });
                }
                const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
                await sendVerificationEmail(user.email, token, baseUrl);
            } catch (err) {
                console.warn('Could not send verification email on login:', err.message);
            }
            return res.redirect('/login?error=unverified&redirect=' + encodeURIComponent(redirectTo));
        }

        req.session.userId = user.uid;
        req.session.email = user.email;
        req.session.name = user.name || user.email;
        req.session.role = isAdmin ? ROLE_ADMIN : ROLE_USER;
        if (!isAdmin && isAdminPath(redirectTo)) redirectTo = '/';
        req.session.save((err) => {
            if (err) return res.redirect('/login?error=error&redirect=' + encodeURIComponent(redirectTo));
            res.redirect(redirectTo);
        });
    } catch (e) {
        return res.redirect('/login?error=error&redirect=' + encodeURIComponent(redirectTo));
    }
});

app.post('/register', async (req, res) => {
    const { email, password } = req.body || {};
    let redirectTo = (req.body && req.body.redirect) || '/';
    try {
        if (!password || password.length < 6) return res.redirect('/login?error=password_length&redirect=' + encodeURIComponent(redirectTo));
        const displayName = (req.body.name || '').trim();
        const normalized = (email || '').trim().toLowerCase();
        const token = crypto.randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');
        const expires = Date.now() + VERIFICATION_TOKEN_TTL_MS;

        await createUser(normalized, password, ROLE_USER, displayName, {
            verified: false,
            verificationToken: token,
            verificationExpires: expires
        });

        // Try to send verification email, but do not fail registration if this breaks
        try {
            const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            await sendVerificationEmail(normalized, token, baseUrl);
        } catch (mailErr) {
            console.warn('Registration: could not send verification email:', mailErr.message);
        }
    } catch (e) {
        const msg = e.message === 'Email already registered' ? 'email_taken' : 'error';
        return res.redirect('/login?error=' + msg + '&redirect=' + encodeURIComponent(redirectTo));
    }
    if (isAdminPath(redirectTo)) redirectTo = '/';
    return res.redirect('/login?success=check_email&redirect=' + encodeURIComponent(redirectTo));
});

// Email verification callback route
app.get('/verify-email', async (req, res) => {
    const token = (req.query.token || '').trim();
    const emailRaw = (req.query.email || '').trim().toLowerCase();

    if (!token || !emailRaw) {
        return res.redirect('/login?error=invalid_token');
    }

    try {
        const user = await findUserByEmail(emailRaw);
        if (!user) {
            return res.redirect('/login?error=invalid_token');
        }

        // If already verified, just show a friendly message
        if (user.verified === true) {
            return res.redirect('/login?success=already_verified');
        }

        const now = Date.now();
        if (!user.verificationToken ||
            !user.verificationExpires ||
            user.verificationToken !== token ||
            user.verificationExpires <= now) {
            return res.redirect('/login?error=invalid_or_expired_token');
        }

        await usersRef.child(user.uid).update({
            verified: true,
            verificationToken: null,
            verificationExpires: null
        });

        return res.redirect('/login?success=verified');
    } catch (err) {
        console.warn('Error verifying email:', err.message);
        return res.redirect('/login?error=error');
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => {});
    res.redirect('/');
});

const requireLogin = (req, res, next) => {
    if (!req.session || !req.session.userId) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl || '/account/settings'));
    next();
};

app.get('/account/settings', requireLogin, async (req, res) => {
    const user = await getUserById(req.session.userId);
    if (!user) return res.redirect('/logout');
    res.render('account/settings', {
        title: 'Account Settings',
        account: { email: user.email, name: user.name || '' },
        error: req.query.error,
        success: req.query.success
    });
});

app.post('/account/settings', requireLogin, async (req, res) => {
    const uid = req.session.userId;
    const user = await getUserById(uid);
    if (!user) return res.redirect('/logout');

    const newName = (req.body.name || '').trim();
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;

    const updates = {};
    if (newName !== undefined) updates.name = newName;

    if (newPassword && newPassword.length >= 6) {
        if (!currentPassword) return res.redirect('/account/settings?error=current_required');
        const valid = await verifyPassword(currentPassword, user.passwordHash);
        if (!valid) return res.redirect('/account/settings?error=wrong_password');
        updates.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    } else if (req.body.newPassword && req.body.newPassword.length > 0 && req.body.newPassword.length < 6) {
        return res.redirect('/account/settings?error=password_length');
    }

    if (Object.keys(updates).length > 0) {
        await usersRef.child(uid).update(updates);
        if (updates.name !== undefined) req.session.name = updates.name;
    }
    return res.redirect('/account/settings?success=1');
});

// --- Admin: Attractions CRUD (requireAdmin) ---
const DEFAULT_CATEGORIES = ['Nature', 'Heritage', 'Cultural', 'Resort', 'Agri-Tourism', 'Landmark', 'Food / Resto', 'Accommodation', 'Event-Place'];
let categoriesList = [...DEFAULT_CATEGORIES];

function loadCategoriesFromFirebase() {
    categoriesRef.once('value').then(snapshot => {
        const val = snapshot.val();
        if (val && Array.isArray(val)) {
            categoriesList = [...val];
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            categoriesList = Object.values(val).filter(Boolean);
        }
        if (categoriesList.length === 0) {
            categoriesList = [...DEFAULT_CATEGORIES];
            saveCategoriesToFirebase();
        }
    }).catch(err => {
        console.error('Error loading categories from Firebase:', err);
        categoriesList = [...DEFAULT_CATEGORIES];
    });
}

function saveCategoriesToFirebase() {
    return categoriesRef.set(categoriesList).catch(e => console.error('Could not save categories to Firebase:', e.message));
}

loadCategoriesFromFirebase();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB
const PUBLIC_IMAGES = path.join(__dirname, 'public', 'images');

async function saveUploadedImages(attractionId, mainFile, galleryFiles) {
    const result = { image: null, gallery: [] };
    if (!attractionId || !/^[a-z0-9-]+$/.test(attractionId)) return result;
    const supabase = getSupabase();
    if (supabase) {
        const prefix = 'images/' + attractionId + '/';
        try {
            if (mainFile && mainFile[0] && mainFile[0].buffer) {
                const ext = (mainFile[0].mimetype === 'image/png') ? '.png' : '.jpg';
                const storagePath = prefix + 'main' + ext;
                const contentType = mainFile[0].mimetype || 'image/jpeg';
                const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(storagePath, mainFile[0].buffer, { contentType, upsert: true });
                if (!error) result.image = '/images/' + attractionId + '/main' + ext;
                else console.error('saveUploadedImages (main):', error.message);
            }
            if (galleryFiles && Array.isArray(galleryFiles) && galleryFiles.length > 0) {
                for (let i = 0; i < galleryFiles.length; i++) {
                    const file = galleryFiles[i];
                    if (!file || !file.buffer) continue;
                    const ext = (file.mimetype === 'image/png') ? '.png' : '.jpg';
                    const storagePath = prefix + (i + 1) + ext;
                    const contentType = file.mimetype || 'image/jpeg';
                    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(storagePath, file.buffer, { contentType, upsert: true });
                    if (!error) result.gallery.push('/images/' + attractionId + '/' + (i + 1) + ext);
                    else console.error('saveUploadedImages (gallery):', error.message);
                }
            }
        } catch (e) {
            console.error('saveUploadedImages:', e.message);
        }
        return result;
    }
    const dir = path.join(PUBLIC_IMAGES, attractionId);
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (mainFile && mainFile[0] && mainFile[0].buffer) {
            const ext = (mainFile[0].mimetype === 'image/png') ? '.png' : '.jpg';
            const dest = path.join(dir, 'main' + ext);
            fs.writeFileSync(dest, mainFile[0].buffer);
            result.image = '/images/' + attractionId + '/main' + ext;
        }
        if (galleryFiles && Array.isArray(galleryFiles) && galleryFiles.length > 0) {
            galleryFiles.forEach((file, i) => {
                if (!file || !file.buffer) return;
                const ext = (file.mimetype === 'image/png') ? '.png' : '.jpg';
                const dest = path.join(dir, (i + 1) + ext);
                fs.writeFileSync(dest, file.buffer);
                result.gallery.push('/images/' + attractionId + '/' + (i + 1) + ext);
            });
        }
    } catch (e) {
        console.error('saveUploadedImages:', e.message);
    }
    return result;
}

function parseAttractionFromBody(body, existing, uploaded) {
    const id = (body.id || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || (existing && existing.id);
    const lng = parseFloat(body.lng);
    const lat = parseFloat(body.lat);
    const coordinates = (Number.isFinite(lng) && Number.isFinite(lat)) ? [lng, lat] : (existing && existing.coordinates) || [];
    let gallery = (uploaded && Array.isArray(uploaded.gallery)) ? uploaded.gallery : null;
    if (gallery === null) {
        const galleryRaw = (body.gallery || '').trim();
        gallery = galleryRaw ? galleryRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : (existing && existing.gallery) || [];
    }
    const active = body.active === 'on' || body.active === 'true' || body.active === true;
    const base = existing ? { ...existing } : {};
    const image = (uploaded && uploaded.image) || (body.image || '').trim() || base.image || '';
    return {
        ...base,
        id: id || base.id,
        name: (body.name || '').trim() || base.name,
        category: (body.category || '').trim() || base.category,
        image: image || base.image,
        desc: (body.desc || '').trim() || base.desc,
        highlights: (body.highlights || '').trim() || base.highlights,
        uniqueHighlight: (body.uniqueHighlight || '').trim() || base.uniqueHighlight,
        coordinates,
        gallery: Array.isArray(gallery) ? gallery : (base.gallery || []),
        active,
        openingHours: (body.openingHours || '').trim() || base.openingHours,
        entranceFees: (body.entranceFees || '').trim() || base.entranceFees,
        visitorTips: (body.visitorTips || '').trim() || base.visitorTips,
        facebook: (body.facebook || '').trim() || base.facebook,
        phone: (body.phone || '').trim() || base.phone,
        email: (body.email || '').trim() || base.email
    };
}

function normalizeDeleteList(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(String);
    return [String(val)];
}

function galleryBasename(v) {
    const s = String(v || '');
    const parts = s.split('/');
    return parts[parts.length - 1];
}

function listUsedGalleryNumbers(dir) {
    try {
        const files = fs.readdirSync(dir);
        const used = new Set();
        files.forEach(f => {
            const m = /^(\d+)\.(jpg|jpeg|png|webp)$/i.exec(f);
            if (m) used.add(parseInt(m[1], 10));
        });
        return used;
    } catch {
        return new Set();
    }
}

function nextAvailableNumber(used) {
    let i = 1;
    while (used.has(i)) i += 1;
    return i;
}

async function appendGalleryUploads(attractionId, galleryFiles) {
    const added = [];
    if (!attractionId || !/^[a-z0-9-]+$/.test(attractionId)) return added;
    if (!galleryFiles || !Array.isArray(galleryFiles) || galleryFiles.length === 0) return added;
    const supabase = getSupabase();
    if (supabase) {
        const prefix = 'images/' + attractionId + '/';
        try {
            const used = new Set();
            const { data: files } = await supabase.storage.from(SUPABASE_BUCKET).list(prefix.replace(/\/$/, ''));
            (files || []).forEach(f => {
                const m = /^(\d+)\.(jpg|jpeg|png|webp)$/i.exec(f.name);
                if (m) used.add(parseInt(m[1], 10));
            });
            for (const file of galleryFiles) {
                if (!file || !file.buffer) continue;
                const ext = (file.mimetype === 'image/png') ? '.png' : '.jpg';
                const n = nextAvailableNumber(used);
                used.add(n);
                const storagePath = prefix + n + ext;
                const contentType = file.mimetype || 'image/jpeg';
                const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(storagePath, file.buffer, { contentType, upsert: true });
                if (!error) added.push('/images/' + attractionId + '/' + n + ext);
                else console.error('appendGalleryUploads:', error.message);
            }
        } catch (e) {
            console.error('appendGalleryUploads:', e.message);
        }
        return added;
    }
    const dir = path.join(PUBLIC_IMAGES, attractionId);
    try {
        fs.mkdirSync(dir, { recursive: true });
        const used = listUsedGalleryNumbers(dir);
        galleryFiles.forEach(file => {
            if (!file || !file.buffer) return;
            const ext = (file.mimetype === 'image/png') ? '.png' : '.jpg';
            const n = nextAvailableNumber(used);
            used.add(n);
            const dest = path.join(dir, String(n) + ext);
            fs.writeFileSync(dest, file.buffer);
            added.push('/images/' + attractionId + '/' + n + ext);
        });
    } catch (e) {
        console.error('appendGalleryUploads:', e.message);
    }
    return added;
}

async function deleteGalleryFiles(attractionId, deleteValues) {
    const basenames = normalizeDeleteList(deleteValues).map(galleryBasename).filter(Boolean);
    if (!basenames.length) return [];
    const supabase = getSupabase();
    if (supabase) {
        const toRemove = basenames.map(b => 'images/' + attractionId + '/' + b);
        const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(toRemove);
        if (error) console.warn('deleteGalleryFiles:', error.message);
        return basenames;
    }
    const dir = path.join(PUBLIC_IMAGES, attractionId);
    const deleted = [];
    basenames.forEach(b => {
        try {
            const full = path.join(dir, b);
            if (fs.existsSync(full)) {
                fs.unlinkSync(full);
                deleted.push(b);
            }
        } catch (e) {
            console.warn('deleteGalleryFiles:', e.message);
        }
    });
    return deleted;
}

async function deleteAttractionImages(attractionId) {
    if (!attractionId || !/^[a-z0-9-]+$/.test(attractionId)) return;
    const supabase = getSupabase();
    if (supabase) {
        try {
            const { data: files } = await supabase.storage.from(SUPABASE_BUCKET).list('images/' + attractionId);
            if (files && files.length > 0) {
                const paths = files.map(f => 'images/' + attractionId + '/' + f.name);
                await supabase.storage.from(SUPABASE_BUCKET).remove(paths);
            }
        } catch (e) {
            console.warn('deleteAttractionImages:', e.message);
        }
        return;
    }
    const dir = path.join(PUBLIC_IMAGES, attractionId);
    try {
        if (fs.existsSync(dir)) {
            if (typeof fs.rmSync === 'function') {
                fs.rmSync(dir, { recursive: true, force: true });
            } else {
                fs.rmdirSync(dir, { recursive: true });
            }
        }
    } catch (e) {
        console.warn('deleteAttractionImages:', e.message);
    }
}

app.get('/admin/attractions', requireAdmin, (req, res) => {
    res.render('admin/attractions-list', {
        title: 'Manage Attractions',
        attractions: attractions.map(a => ({ ...a, stats: getAttractionStats(a.id) })),
        categories: categoriesList
    });
});

app.get('/admin/attractions/add', requireAdmin, (req, res) => {
    res.render('admin/addattraction', { title: 'Add Attraction', attraction: null, categories: categoriesList, edit: false, error: req.query.error });
});

app.post('/admin/attractions/add', requireAdmin, upload.fields([{ name: 'mainImage', maxCount: 1 }, { name: 'galleryImages', maxCount: 20 }]), async (req, res) => {
    const att = parseAttractionFromBody(req.body, null, null);
    if (!att.id || !att.name) {
        return res.redirect('/admin/attractions/add?error=missing');
    }
    if (attractions.some(a => a.id === att.id)) {
        return res.redirect('/admin/attractions/add?error=duplicate');
    }
    const uploaded = await saveUploadedImages(att.id, req.files && req.files.mainImage, req.files && req.files.galleryImages);
    const attFinal = parseAttractionFromBody(req.body, null, uploaded);
    attractions.push(attFinal);
    saveAttractionsToFirebase();
    res.redirect('/admin/attractions');
});

app.get('/admin/attractions/edit/:id', requireAdmin, (req, res) => {
    const attraction = attractions.find(a => a.id === req.params.id);
    if (!attraction) return res.redirect('/admin/attractions');
    res.render('admin/addattraction', { title: 'Edit Attraction', attraction, categories: categoriesList, edit: true, error: req.query.error });
});

app.post('/admin/attractions/update/:id', requireAdmin, upload.fields([{ name: 'mainImage', maxCount: 1 }, { name: 'galleryImages', maxCount: 20 }]), async (req, res) => {
    const existing = attractions.find(a => a.id === req.params.id);
    if (!existing) return res.redirect('/admin/attractions');
    // main image can be replaced; gallery can be deleted selectively and/or appended
    const mainUploaded = await saveUploadedImages(req.params.id, req.files && req.files.mainImage, null);
    const deletedBasenames = await deleteGalleryFiles(req.params.id, req.body.deleteGallery);
    const keptGallery = (existing.gallery || []).filter(src => !deletedBasenames.includes(galleryBasename(src)));
    const addedGallery = await appendGalleryUploads(req.params.id, req.files && req.files.galleryImages);
    const finalGallery = [...keptGallery, ...addedGallery];
    const uploaded = { image: mainUploaded.image, gallery: finalGallery };
    const att = parseAttractionFromBody(req.body, existing, uploaded);
    const idx = attractions.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.redirect('/admin/attractions');
    attractions[idx] = att;
    saveAttractionsToFirebase();
    res.redirect('/admin/attractions');
});

app.post('/admin/attractions/delete/:id', requireAdmin, async (req, res) => {
    const idx = attractions.findIndex(a => a.id === req.params.id);
    if (idx !== -1) {
        const deleted = attractions[idx];
        attractions.splice(idx, 1);
        saveAttractionsToFirebase();
        if (deleted && deleted.id) {
            await deleteAttractionImages(deleted.id);
        }
    }
    res.redirect('/admin/attractions');
});

app.post('/admin/attractions/toggle-active/:id', requireAdmin, (req, res) => {
    const att = attractions.find(a => a.id === req.params.id);
    if (att) {
        att.active = att.active === false; // toggle: false -> true, true -> false
        saveAttractionsToFirebase();
    }
    res.redirect('/admin/attractions');
});

// --- Admin: Category management (API for add/edit/delete) ---
app.get('/api/admin/categories', requireAdminApi, (req, res) => {
    res.json({ categories: categoriesList });
});

app.post('/api/admin/categories', requireAdminApi, (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name).trim() : '';
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    if (categoriesList.includes(name)) return res.status(400).json({ error: 'Category already exists' });
    categoriesList.push(name);
    saveCategoriesToFirebase();
    res.json({ categories: categoriesList });
});

app.put('/api/admin/categories', requireAdminApi, (req, res) => {
    const oldName = (req.body && req.body.oldName) ? String(req.body.oldName).trim() : '';
    const newName = (req.body && req.body.newName) ? String(req.body.newName).trim() : '';
    if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName are required' });
    const idx = categoriesList.indexOf(oldName);
    if (idx === -1) return res.status(404).json({ error: 'Category not found' });
    if (categoriesList.includes(newName) && newName !== oldName) return res.status(400).json({ error: 'New name already exists' });
    categoriesList[idx] = newName;
    saveCategoriesToFirebase();
    res.json({ categories: categoriesList });
});

app.delete('/api/admin/categories', requireAdminApi, (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name).trim() : '';
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const idx = categoriesList.indexOf(name);
    if (idx === -1) return res.status(404).json({ error: 'Category not found' });
    categoriesList.splice(idx, 1);
    saveCategoriesToFirebase();
    res.json({ categories: categoriesList });
});

// --- Admin: Reviews moderation (requireAdmin) ---
app.get('/admin/reviews', requireAdmin, async (req, res) => {
    const snapshot = await reviewsRef.once('value');
    const val = snapshot.val() || {};
    const attractionNameById = {};
    attractions.forEach(a => { attractionNameById[a.id] = a.name; });

    // Build list of attractions that have reviews, with count (only include known attractions)
    const countByAttraction = {};
    for (const [attractionId, reviewsObj] of Object.entries(val)) {
        if (!reviewsObj) continue;
        countByAttraction[attractionId] = Object.keys(reviewsObj).length;
    }
    const attractionsWithReviews = Object.entries(countByAttraction)
        .filter(([id]) => attractionNameById[id])
        .map(([id]) => ({ id, name: attractionNameById[id], count: countByAttraction[id] }))
        .sort((a, b) => a.name.localeCompare(b.name));

    res.render('admin/reviews', { title: 'Moderate Reviews', attractionsWithReviews });
});

app.get('/admin/reviews/data/:attractionId', requireAdmin, async (req, res) => {
    const reviews = await getReviewsForAttraction(req.params.attractionId);
    res.json(reviews);
});

app.post('/admin/reviews/delete/:attractionId/:reviewId', requireAdmin, async (req, res) => {
    await reviewsRef.child(req.params.attractionId).child(req.params.reviewId).remove();
    res.redirect('/admin/reviews#' + encodeURIComponent(req.params.attractionId));
});

// --- Admin: Reported comments (requireAdmin) ---
app.get('/admin/reportacc', requireAdmin, async (req, res) => {
    const snapshot = await reportsRef.once('value');
    const val = snapshot.val() || {};
    const reports = Object.entries(val).map(([id, r]) => ({ id, ...r }))
        .sort((a, b) => (new Date(b.createdAt) || 0) - (new Date(a.createdAt) || 0));
    res.render('admin/reportacc', { title: 'Reported Comments', reports });
});

app.post('/admin/reports/:reportId/dismiss', requireAdmin, async (req, res) => {
    const ref = reportsRef.child(req.params.reportId);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.redirect('/admin/reportacc');
    await ref.update({ status: 'dismissed', updatedAt: new Date().toISOString() });
    res.redirect('/admin/reportacc');
});

app.post('/admin/reports/:reportId/ban', requireAdmin, async (req, res) => {
    const ref = reportsRef.child(req.params.reportId);
    const snap = await ref.once('value');
    const report = snap.val();
    if (!report) return res.redirect('/admin/reportacc');
    const uid = report.commentAuthorUserId;
    if (uid) {
        await usersRef.child(uid).update({ banned: true, bannedAt: new Date().toISOString() });
    }
    await ref.update({ status: 'action_taken', updatedAt: new Date().toISOString() });
    res.redirect('/admin/reportacc');
});

app.post('/admin/reports/:reportId/unban', requireAdmin, async (req, res) => {
    const ref = reportsRef.child(req.params.reportId);
    const snap = await ref.once('value');
    const report = snap.val();
    if (!report) return res.redirect('/admin/reportacc');
    const uid = report.commentAuthorUserId;
    if (uid) {
        await usersRef.child(uid).update({ banned: false, bannedAt: null });
    }
    await ref.update({ status: 'ban_reversed', updatedAt: new Date().toISOString() });
    res.redirect('/admin/reportacc');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
    // Add these headers to prevent caching on Vercel and the browser
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const attractionsWithVisits = getAttractionsWithVisits();
    const totalVisits = attractionsWithVisits.reduce((sum, a) => sum + a.visits, 0);
    res.render('admin/dashboard', {
        title: 'Analytics Dashboard - Visit Naujan',
        attractionsWithVisits,
        totalVisits,
        lastResetAt
    });
});

app.post('/admin/dashboard/reset', requireAdmin, async (req, res) => {
    console.log('Received POST /admin/dashboard/reset');
    await resetVisits();
    res.redirect('/admin/dashboard');
});

app.post('/admin/dashboard/reset-favs', requireAdmin, async (req, res) => {
    console.log('Received POST /admin/dashboard/reset-favs');
    await resetFavs();
    res.redirect('/admin/dashboard');
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Naujan Tourism Site running at http://localhost:${port}`);
    });
}

// Required for Vercel to recognize the Express app
module.exports = app;
