// ═══════════════════════════════════════════════════════════
// TripQuest · App Orchestrator
// Manages all screens, tabs, and feature logic
// ═══════════════════════════════════════════════════════════

import {
  getClient, isConnected, testConnection, getCredentials, saveCredentials,
  getSession, onAuthChange, getLocalSession,
  signInWithGoogle, signInWithEmail, signUpWithEmail, signOut,
  getProfile, createProfile,
  getPublishedTrip, getAllTrips, saveTrip, publishTrip,
  getDestinations, saveDestinations,
  getChatMessages, sendChatMessage,
  subscribeToChatMessages, subscribeToItinerary
} from './supabase.js';

// ── App-level state ──────────────────────────────────────
const App = {
  session: null,      // Supabase session object
  profile: null,      // { id, display_name, profile_photo, is_admin }
  trip: null,         // active published trip
  destinations: [],   // ordered list with computed distances
  messages: [],       // chat messages
  adminDrafts: [],    // admin panel working list
  adminTripId: null,  // id of trip being edited
  unsubChat: null,    // cleanup fn for chat subscription
  unsubItinerary: null,// cleanup fn for itinerary subscription
  unreadChat: 0       // unread chat count
};

// Profile photo selected in profile setup
let setupPhotoBase64 = null;

// ── Helpers ───────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function estimateTravelTime(km) {
  // < 1 km → walk at 5 km/h, else drive at 30 km/h
  if (km < 1) {
    const mins = Math.ceil((km / 5) * 60);
    return `~${mins} min walk`;
  }
  const mins = Math.ceil((km / 30) * 60);
  return `~${mins} min drive`;
}

function formatChatTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── Screen / Tab Routing ──────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function showTab(tabId) {
  // Update nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Show correct pane
  ['itinerary', 'tasks', 'chat'].forEach(t => {
    const pane = document.getElementById(`tab-${t}`);
    if (pane) {
      pane.style.display = (t === tabId) ? 'flex' : 'none';
      pane.classList.toggle('active', t === tabId);
    }
  });

  // Clear unread badge when chat opened
  if (tabId === 'chat') {
    App.unreadChat = 0;
    updateChatBadge();
    scrollChatToBottom();
  }
}

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  if (App.unreadChat > 0) {
    badge.textContent = App.unreadChat > 9 ? '9+' : App.unreadChat;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

// ══════════════════════════════════════════════════════════
// BOOT — called on DOMContentLoaded
// ══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Bind all events first (safe order)
  bindAuthScreenEvents();
  bindProfileSetupEvents();
  bindAppEvents();
  bindAdminEvents();
  bindSupabaseModalEvents();

  // Prefill Supabase credentials if already saved
  const creds = getCredentials();
  if (creds.url) document.getElementById('sb-url').value = creds.url;
  if (creds.key) document.getElementById('sb-key').value = creds.key;

  // Listen for auth state changes from Supabase (handles OAuth redirect)
  onAuthChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      await handleSignedInSession(session);
    } else if (event === 'SIGNED_OUT') {
      handleSignedOut();
    }
  });

  // Check for existing session
  const session = await getSession();
  if (session) {
    await handleSignedInSession(session);
    return;
  }

  // Check local fallback session
  const localSession = getLocalSession();
  if (localSession) {
    await handleSignedInSession(localSession);
    return;
  }

  // No session — show auth screen
  showScreen('screen-auth');
});

// ══════════════════════════════════════════════════════════
// AUTH FLOW
// ══════════════════════════════════════════════════════════

/** After session is established (Google redirect or email login) */
async function handleSignedInSession(session) {
  App.session = session;
  const userId = session.user.id;

  // Check if profile exists
  const profile = await getProfile(userId);

  if (profile && profile.display_name) {
    // ── RETURNING USER ── skip profile setup
    App.profile = profile;
    await enterMainApp();
  } else {
    // ── FIRST TIME USER ── show profile setup
    // Pre-fill name from Google metadata if available
    const googleName = session.user.user_metadata?.full_name
      || session.user.user_metadata?.name
      || '';
    const nameInput = document.getElementById('setup-display-name');
    if (nameInput && googleName) nameInput.value = googleName;

    // Pre-show Google avatar if available
    const googlePhoto = session.user.user_metadata?.avatar_url
      || session.user.user_metadata?.picture
      || '';
    if (googlePhoto) {
      const letter = document.getElementById('setup-photo-letter');
      const img = document.getElementById('setup-photo-img');
      if (letter) letter.style.display = 'none';
      if (img) { img.src = googlePhoto; img.style.display = 'block'; }
    } else if (googleName) {
      const letter = document.getElementById('setup-photo-letter');
      if (letter) letter.textContent = googleName.charAt(0).toUpperCase();
    }

    showScreen('screen-profile-setup');
  }
}

function handleSignedOut() {
  App.session = null;
  App.profile = null;
  App.trip = null;
  App.destinations = [];
  App.messages = [];
  if (App.unsubChat) { App.unsubChat(); App.unsubChat = null; }
  if (App.unsubItinerary) { App.unsubItinerary(); App.unsubItinerary = null; }
  showScreen('screen-auth');
}

/** Enter the main 3-tab application */
async function enterMainApp() {
  // Update header avatar
  updateHeaderAvatar();

  // Load itinerary
  await loadItinerary();

  // Load chat
  await loadChat();

  showScreen('screen-app');
  showTab('itinerary');
}

// ── Auth Screen Events ──

function bindAuthScreenEvents() {
  // Google Sign In
  document.getElementById('btn-google-signin').addEventListener('click', async () => {
    if (!isConnected()) {
      showToast('Please configure the Supabase backend first (⚡ Setup Backend)', 'warning', 4000);
      return;
    }
    try {
      await signInWithGoogle();
      // Page will redirect — Supabase handles the rest via onAuthChange
    } catch (err) {
      showToast(err.message || 'Google sign-in failed.', 'error');
    }
  });

  // Email tab switcher
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const nameRow = document.getElementById('auth-name-row');
  const authBtn = document.getElementById('btn-email-auth');

  let authMode = 'login';

  tabLogin.addEventListener('click', () => {
    authMode = 'login';
    tabLogin.classList.add('active');
    tabSignup.classList.remove('active');
    nameRow.style.display = 'none';
    authBtn.textContent = 'Log In →';
  });

  tabSignup.addEventListener('click', () => {
    authMode = 'signup';
    tabSignup.classList.add('active');
    tabLogin.classList.remove('active');
    nameRow.style.display = 'block';
    authBtn.textContent = 'Sign Up →';
  });

  // Email auth submit
  authBtn.addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();

    if (!email || !password) {
      showToast('Please enter email and password.', 'warning');
      return;
    }

    authBtn.textContent = '...';
    authBtn.disabled = true;

    try {
      let session;
      if (authMode === 'signup') {
        session = await signUpWithEmail(email, password);
        if (!session) {
          showToast('Check your email to confirm your account, then log in.', 'info', 5000);
          authBtn.textContent = 'Sign Up →';
          authBtn.disabled = false;
          return;
        }
      } else {
        session = await signInWithEmail(email, password);
      }

      if (session) {
        await handleSignedInSession(session);
      }
    } catch (err) {
      showToast(err.message || 'Authentication failed.', 'error');
    } finally {
      authBtn.textContent = authMode === 'login' ? 'Log In →' : 'Sign Up →';
      authBtn.disabled = false;
    }
  });

  // Enter key in password
  document.getElementById('auth-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-email-auth').click();
  });

  // Open Supabase setup
  document.getElementById('btn-open-sb-setup').addEventListener('click', () => {
    document.getElementById('modal-supabase').classList.add('open');
  });
}

// ══════════════════════════════════════════════════════════
// PROFILE SETUP (FIRST TIME)
// ══════════════════════════════════════════════════════════

function bindProfileSetupEvents() {
  const photoFile = document.getElementById('setup-photo-file');
  const photoLetter = document.getElementById('setup-photo-letter');
  const photoImg = document.getElementById('setup-photo-img');
  const removeBtn = document.getElementById('btn-remove-setup-photo');
  const nameInput = document.getElementById('setup-display-name');

  // Name → update letter preview
  nameInput.addEventListener('input', () => {
    if (!setupPhotoBase64 && photoImg.style.display === 'none') {
      photoLetter.textContent = nameInput.value.trim().charAt(0).toUpperCase() || '?';
    }
  });

  // Photo file picker
  photoFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file.', 'warning');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('Image must be under 5MB.', 'warning');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      setupPhotoBase64 = ev.target.result;
      photoImg.src = setupPhotoBase64;
      photoImg.style.display = 'block';
      photoLetter.style.display = 'none';
      if (removeBtn) removeBtn.style.display = 'inline-block';
      showToast('Photo selected!', 'success');
    };
    reader.readAsDataURL(file);
  });

  // Remove photo
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      setupPhotoBase64 = null;
      photoImg.style.display = 'none';
      photoImg.src = '';
      photoLetter.style.display = 'block';
      photoLetter.textContent = nameInput.value.trim().charAt(0).toUpperCase() || '?';
      removeBtn.style.display = 'none';
      photoFile.value = '';
    });
  }

  // Save profile
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Please enter your display name.', 'warning');
      nameInput.focus();
      return;
    }

    const btn = document.getElementById('btn-save-profile');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      const userId = App.session.user.id;

      // Use Google photo if no custom photo selected but Google avatar available
      const googlePhoto = App.session.user.user_metadata?.avatar_url
        || App.session.user.user_metadata?.picture
        || null;
      const finalPhoto = setupPhotoBase64 || googlePhoto || null;

      const profile = await createProfile(userId, name, finalPhoto);
      App.profile = profile;
      setupPhotoBase64 = null;

      showToast(`Welcome, ${name}! 🎉`, 'success');
      await enterMainApp();
    } catch (err) {
      showToast(err.message || 'Failed to save profile.', 'error');
    } finally {
      btn.textContent = 'Start Exploring 🚀';
      btn.disabled = false;
    }
  });
}

// ══════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════

function bindAppEvents() {
  // Bottom nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Admin button
  document.getElementById('btn-open-admin').addEventListener('click', async () => {
    await loadAdminPanel();
    showScreen('screen-admin');
  });

  // Chat send
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-chat-send');

  const doSend = async () => {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';

    if (!App.trip) {
      showToast('No active trip to chat in.', 'warning');
      return;
    }

    try {
      const msg = await sendChatMessage(
        App.trip.id,
        App.session.user.id,
        App.profile.display_name,
        App.profile.profile_photo,
        text
      );
      // For local fallback, append immediately
      if (!getClient()) {
        appendChatMessage(msg);
        scrollChatToBottom();
      }
    } catch (err) {
      showToast('Failed to send message.', 'error');
    }
  };

  sendBtn.addEventListener('click', doSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
}

function updateHeaderAvatar() {
  const letterEl = document.getElementById('header-avatar-letter');
  const imgEl = document.getElementById('header-avatar-img');

  if (!App.profile) return;

  if (App.profile.profile_photo) {
    imgEl.src = App.profile.profile_photo;
    imgEl.style.display = 'block';
    letterEl.style.display = 'none';
  } else {
    letterEl.textContent = (App.profile.display_name || '?').charAt(0).toUpperCase();
    letterEl.style.display = 'flex';
    imgEl.style.display = 'none';
  }
}

// ── Itinerary ──

async function loadItinerary() {
  const trip = await getPublishedTrip();
  App.trip = trip;

  if (!trip) {
    document.getElementById('itinerary-empty').style.display = 'flex';
    document.getElementById('itinerary-list').style.display = 'none';
    document.getElementById('trip-banner').style.display = 'none';
    return;
  }

  // Load destinations
  const dests = await getDestinations(trip.id);
  App.destinations = computeDistances(dests);

  renderItinerary();

  // Subscribe to live itinerary updates
  if (App.unsubItinerary) App.unsubItinerary();
  App.unsubItinerary = subscribeToItinerary(trip.id, async () => {
    const updated = await getDestinations(trip.id);
    App.destinations = computeDistances(updated);
    renderItinerary();
  });
}

/** Compute cumulative distances between consecutive destinations */
function computeDistances(dests) {
  return dests.map((d, i) => {
    if (i === 0 || !d.lat || !d.lng || !dests[i - 1].lat || !dests[i - 1].lng) {
      return { ...d, distanceKm: null, travelTime: null };
    }
    const prev = dests[i - 1];
    const km = haversineKm(prev.lat, prev.lng, d.lat, d.lng);
    return { ...d, distanceKm: km, travelTime: estimateTravelTime(km) };
  });
}

function renderItinerary() {
  const trip = App.trip;
  const dests = App.destinations;

  const emptyEl = document.getElementById('itinerary-empty');
  const listEl = document.getElementById('itinerary-list');
  const bannerEl = document.getElementById('trip-banner');

  if (!trip || dests.length === 0) {
    emptyEl.style.display = 'flex';
    listEl.style.display = 'none';
    bannerEl.style.display = !trip ? 'none' : 'flex';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.style.display = 'flex';

  // Trip Banner
  bannerEl.style.display = 'flex';
  document.getElementById('trip-banner-name').textContent = trip.name || 'Our Trip';
  const descEl = document.getElementById('trip-banner-desc');
  descEl.textContent = trip.description || '';
  descEl.style.display = trip.description ? 'block' : 'none';
  const dateEl = document.getElementById('trip-banner-date');
  if (trip.start_date) {
    const d = new Date(trip.start_date + 'T00:00:00');
    dateEl.textContent = '📅 ' + d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
    dateEl.style.display = 'block';
  } else {
    dateEl.style.display = 'none';
  }

  // Destination list
  listEl.innerHTML = '';

  dests.forEach((dest, i) => {
    const isFirst = i === 0;
    const isLast = i === dests.length - 1;

    const stopEl = document.createElement('div');
    stopEl.className = 'itinerary-stop';

    // Number column
    const numCol = document.createElement('div');
    numCol.className = 'stop-number-col';

    const numBadge = document.createElement('div');
    numBadge.className = `stop-number${isFirst ? ' first-stop' : ''}`;
    numBadge.textContent = isFirst ? '⭐' : i + 1;
    numCol.appendChild(numBadge);

    if (!isLast) {
      const connector = document.createElement('div');
      connector.className = 'stop-connector';
      numCol.appendChild(connector);
    }

    // Stop card
    const card = document.createElement('div');
    card.className = 'stop-card';

    // Thumbnail
    let thumbHtml = '';
    if (dest.thumbnail) {
      thumbHtml = `<img src="${dest.thumbnail}" alt="${dest.name}" class="stop-thumb" loading="lazy" onerror="this.style.display='none'">`;
    }

    // Distance badge
    let distHtml = '';
    if (i === 0) {
      distHtml = `<div class="stop-label-starting">📍 Starting Point</div>`;
    } else if (dest.distanceKm !== null) {
      distHtml = `
        <div class="stop-distance-badge">
          <span class="stop-distance-icon">↓</span>
          <span class="stop-distance-km">${formatDistance(dest.distanceKm)}</span>
          <span class="stop-travel-time">· ${dest.travelTime}</span>
        </div>
      `;
    }

    // Maps link
    let mapsLinkHtml = '';
    const mapsQuery = dest.lat && dest.lng
      ? `https://www.google.com/maps/search/?api=1&query=${dest.lat},${dest.lng}`
      : (dest.maps_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest.name)}`);
    mapsLinkHtml = `<a href="${mapsQuery}" target="_blank" class="stop-maps-link">🗺️ Open in Google Maps</a>`;

    card.innerHTML = `
      <div class="stop-name">${dest.name}</div>
      ${distHtml}
      ${dest.description ? `<p class="stop-desc">${dest.description}</p>` : ''}
      ${thumbHtml}
      ${mapsLinkHtml}
    `;

    stopEl.appendChild(numCol);
    stopEl.appendChild(card);
    listEl.appendChild(stopEl);
  });
}

// ── Chat ──

async function loadChat() {
  if (!App.trip) return;

  const messages = await getChatMessages(App.trip.id);
  App.messages = messages;
  renderAllMessages();

  // Subscribe to new messages
  if (App.unsubChat) App.unsubChat();
  App.unsubChat = subscribeToChatMessages(App.trip.id, (newMsg) => {
    // Avoid duplicates
    if (App.messages.find(m => m.id === newMsg.id)) return;
    App.messages.push(newMsg);
    appendChatMessage(newMsg);
    scrollChatToBottom();

    // Badge if chat not active
    const chatPane = document.getElementById('tab-chat');
    const isVisible = chatPane && chatPane.classList.contains('active');
    if (!isVisible) {
      App.unreadChat++;
      updateChatBadge();
    }
  });
}

function renderAllMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';

  if (App.messages.length === 0) {
    container.innerHTML = '<div class="chat-empty-hint">Say hi to the group! 👋</div>';
    return;
  }

  App.messages.forEach(msg => appendChatMessage(msg, false));
  scrollChatToBottom();
}

function appendChatMessage(msg, scroll = true) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // Remove empty hint if present
  const hint = container.querySelector('.chat-empty-hint');
  if (hint) hint.remove();

  const isMe = App.session && msg.user_id === App.session.user.id;
  const bubble = document.createElement('div');
  bubble.className = `chat-msg ${isMe ? 'mine' : 'theirs'}`;

  // Avatar: photo or letter
  let avatarHtml;
  if (msg.profile_photo) {
    avatarHtml = `<img src="${msg.profile_photo}" alt="${msg.display_name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    const colors = ['#FF6B4A','#3B82F6','#8B5CF6','#10B981','#F59E0B'];
    const colorIdx = msg.display_name.charCodeAt(0) % colors.length;
    avatarHtml = `<span style="color:#fff; font-size:12px; font-weight:800; background:${colors[colorIdx]}; width:100%; height:100%; display:flex; align-items:center; justify-content:center; border-radius:50%;">${msg.display_name.charAt(0).toUpperCase()}</span>`;
  }

  bubble.innerHTML = `
    <div class="chat-msg-avatar">${avatarHtml}</div>
    <div class="chat-msg-body">
      ${!isMe ? `<div class="chat-msg-name">${msg.display_name}</div>` : ''}
      <div class="chat-msg-bubble">${escapeHtml(msg.text)}</div>
      <div class="chat-msg-time">${formatChatTime(msg.created_at)}</div>
    </div>
  `;

  container.appendChild(bubble);
  if (scroll) scrollChatToBottom();
}

function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ══════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════

async function loadAdminPanel() {
  // Load existing draft trip if any
  const trips = await getAllTrips();
  const draft = trips[0]; // most recent

  if (draft) {
    App.adminTripId = draft.id;
    document.getElementById('admin-trip-name').value = draft.name || '';
    document.getElementById('admin-trip-desc').value = draft.description || '';
    document.getElementById('admin-trip-date').value = draft.start_date || '';

    const dests = await getDestinations(draft.id);
    App.adminDrafts = dests.map(d => ({ ...d }));
  } else {
    App.adminTripId = null;
    App.adminDrafts = [];
    document.getElementById('admin-trip-name').value = '';
    document.getElementById('admin-trip-desc').value = '';
    document.getElementById('admin-trip-date').value = '';
  }

  renderAdminDestList();
}

function bindAdminEvents() {
  // Back
  document.getElementById('btn-admin-back').addEventListener('click', () => {
    showScreen('screen-app');
  });

  // Import from Google Maps URL
  document.getElementById('btn-import-url').addEventListener('click', async () => {
    const urlInput = document.getElementById('admin-url-input');
    const url = urlInput.value.trim();
    if (!url) { showToast('Please paste a Google Maps URL.', 'warning'); return; }

    const btn = document.getElementById('btn-import-url');
    const progress = document.getElementById('import-progress');
    btn.disabled = true;
    btn.textContent = 'Importing...';
    progress.style.display = 'flex';

    try {
      const place = await importFromMapsUrl(url);
      if (!place || !place.name) {
        showToast('Could not parse the URL. Try adding manually.', 'warning');
        return;
      }

      App.adminDrafts.push({
        id: 'tmp_' + Date.now(),
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        maps_url: url,
        thumbnail: place.thumbnail || null,
        description: null
      });

      renderAdminDestList();
      urlInput.value = '';
      showToast(`📍 "${place.name}" imported!`, 'success');
    } catch (err) {
      showToast(err.message || 'Import failed. Add manually instead.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import from Google Maps ⚡';
      progress.style.display = 'none';
    }
  });

  // Add manual place
  document.getElementById('btn-add-manual').addEventListener('click', () => {
    const name = document.getElementById('admin-manual-name').value.trim();
    const lat = parseFloat(document.getElementById('admin-manual-lat').value) || null;
    const lng = parseFloat(document.getElementById('admin-manual-lng').value) || null;

    if (!name) { showToast('Please enter a place name.', 'warning'); return; }

    App.adminDrafts.push({
      id: 'tmp_' + Date.now(),
      name,
      lat,
      lng,
      maps_url: null,
      thumbnail: null,
      description: null
    });

    document.getElementById('admin-manual-name').value = '';
    document.getElementById('admin-manual-lat').value = '';
    document.getElementById('admin-manual-lng').value = '';

    renderAdminDestList();
    showToast(`➕ "${name}" added!`, 'success');
  });

  // Save Draft
  document.getElementById('btn-save-draft').addEventListener('click', async () => {
    await adminSaveAll(false);
  });

  // Publish (header button)
  document.getElementById('btn-publish-header').addEventListener('click', async () => {
    await adminSaveAll(true);
  });

  // Publish (bottom button)
  document.getElementById('btn-publish-bottom').addEventListener('click', async () => {
    await adminSaveAll(true);
  });
}

async function adminSaveAll(publish) {
  const name = document.getElementById('admin-trip-name').value.trim();
  if (!name) { showToast('Please enter a trip name.', 'warning'); return; }

  const desc = document.getElementById('admin-trip-desc').value.trim();
  const date = document.getElementById('admin-trip-date').value;

  const btn = publish
    ? document.getElementById('btn-publish-bottom')
    : document.getElementById('btn-save-draft');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    // Save or create trip
    const tripData = await saveTrip({
      id: App.adminTripId,
      name,
      description: desc,
      startDate: date,
      published: publish ? true : false
    });
    App.adminTripId = tripData.id;

    // Save destinations
    await saveDestinations(App.adminTripId, App.adminDrafts);

    if (publish) {
      await publishTrip(App.adminTripId);
      showToast('🚀 Trip published to the group!', 'success');
      // Reload itinerary in main app
      await loadItinerary();
    } else {
      showToast('💾 Draft saved!', 'success');
    }
  } catch (err) {
    showToast(err.message || 'Save failed. Check your Supabase connection.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

/** Parse Google Maps URL via CORS proxy */
async function importFromMapsUrl(url) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('CORS proxy request failed.');

  const json = await res.json();
  const html = json.contents || '';
  const finalUrl = json.status?.url || url;

  // Extract name from <title>
  let name = 'Imported Place';
  const titleMatch = html.match(/<title[^>]*>([^<|·]+)/i);
  if (titleMatch) {
    name = titleMatch[1]
      .replace(/\s*[-|·]\s*Google Maps.*$/i, '')
      .trim();
  }
  if (!name || name.toLowerCase().includes('google maps')) {
    // Fallback: extract from URL path
    const pathMatch = (finalUrl + url).match(/maps\/place\/([^/@]+)/);
    if (pathMatch) name = decodeURIComponent(pathMatch[1].replace(/\+/g, ' '));
  }

  // Extract coordinates
  let lat = null, lng = null;
  const coordMatch = (finalUrl + html).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (coordMatch) {
    lat = parseFloat(coordMatch[1]);
    lng = parseFloat(coordMatch[2]);
  }

  // Try alternate coord pattern from JSON-LD or meta
  if (!lat) {
    const altMatch = html.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
    if (altMatch) { lat = parseFloat(altMatch[1]); lng = parseFloat(altMatch[2]); }
  }

  // Extract og:image thumbnail
  let thumbnail = null;
  const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (imgMatch) thumbnail = imgMatch[1];

  return { name, lat, lng, thumbnail };
}

/** Render drag-and-drop destination list in admin panel */
function renderAdminDestList() {
  const container = document.getElementById('admin-dest-list');
  const countEl = document.getElementById('dest-count');
  if (!container) return;

  const count = App.adminDrafts.length;
  if (countEl) countEl.textContent = `${count} ${count === 1 ? 'place' : 'places'}`;

  if (count === 0) {
    container.innerHTML = '<div class="admin-dest-empty">No destinations added yet.</div>';
    return;
  }

  container.innerHTML = '';

  App.adminDrafts.forEach((dest, i) => {
    const item = document.createElement('div');
    item.className = 'admin-dest-item';
    item.draggable = true;
    item.dataset.idx = i;

    const coordText = dest.lat && dest.lng
      ? `${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}`
      : 'No coordinates';

    item.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿⠿</span>
      <div class="dest-item-num">${i + 1}</div>
      <div class="dest-item-info">
        <div class="dest-item-name">${dest.name}</div>
        <div class="dest-item-coords">${coordText}</div>
      </div>
      <button class="dest-item-remove" data-idx="${i}" title="Remove">✕</button>
    `;

    // Remove button
    item.querySelector('.dest-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.idx);
      App.adminDrafts.splice(idx, 1);
      renderAdminDestList();
    });

    container.appendChild(item);
  });

  // ── Drag-and-Drop ──
  let dragSrcIdx = null;

  container.querySelectorAll('.admin-dest-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragSrcIdx = parseInt(item.dataset.idx);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.admin-dest-item').forEach(i => i.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.admin-dest-item').forEach(i => i.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIdx = parseInt(item.dataset.idx);
      if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;

      // Reorder
      const moved = App.adminDrafts.splice(dragSrcIdx, 1)[0];
      App.adminDrafts.splice(targetIdx, 0, moved);
      dragSrcIdx = null;

      renderAdminDestList();
    });
  });
}

// ══════════════════════════════════════════════════════════
// SUPABASE SETUP MODAL
// ══════════════════════════════════════════════════════════

function bindSupabaseModalEvents() {
  const modal = document.getElementById('modal-supabase');
  const statusEl = document.getElementById('sb-connection-status');

  // Close
  document.getElementById('btn-sb-cancel').addEventListener('click', () => {
    modal.classList.remove('open');
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('open');
  });

  // Connect
  document.getElementById('btn-sb-connect').addEventListener('click', async () => {
    const url = document.getElementById('sb-url').value.trim();
    const key = document.getElementById('sb-key').value.trim();

    if (!url || !key) {
      statusEl.textContent = 'Please enter both URL and API key.';
      statusEl.className = 'sb-status err';
      return;
    }

    const btn = document.getElementById('btn-sb-connect');
    btn.textContent = 'Testing...';
    btn.disabled = true;
    statusEl.textContent = 'Connecting...';
    statusEl.className = 'sb-status';

    const result = await testConnection(url, key);

    if (result.ok) {
      statusEl.textContent = '✅ Connected successfully!';
      statusEl.className = 'sb-status ok';
      showToast('Supabase connected!', 'success');
      setTimeout(() => modal.classList.remove('open'), 1200);
    } else {
      statusEl.textContent = `❌ ${result.message}`;
      statusEl.className = 'sb-status err';
    }

    btn.textContent = 'Connect 🔌';
    btn.disabled = false;
  });

  // Also open from auth screen (already bound via btn-open-sb-setup)
}
