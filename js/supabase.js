// ═══════════════════════════════════════════════════════════
// TripQuest · Supabase Interface
// Handles: client init, auth (Google + email), database ops
// ═══════════════════════════════════════════════════════════

let _client = null;

/* ── Credential Storage ── */
const CREDS_URL = 'tripquest_supabase_url';
const CREDS_KEY = 'tripquest_supabase_anon_key';

export function saveCredentials(url, key) {
  localStorage.setItem(CREDS_URL, url.trim());
  localStorage.setItem(CREDS_KEY, key.trim());
  _client = null; // force re-init
}

export function getCredentials() {
  return {
    url: localStorage.getItem(CREDS_URL) || '',
    key: localStorage.getItem(CREDS_KEY) || ''
  };
}

/* ── Client Init ── */
export function getClient() {
  if (_client) return _client;
  const { url, key } = getCredentials();
  if (!url || !key || !window.supabase) return null;
  try {
    _client = window.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true // critical for OAuth redirect
      }
    });
    return _client;
  } catch (e) {
    console.error('[Supabase] Client init failed:', e);
    return null;
  }
}

export function isConnected() {
  const { url, key } = getCredentials();
  return !!(url && key);
}

/* ── Test Connection ── */
export async function testConnection(url, key) {
  if (!window.supabase) return { ok: false, message: 'Supabase library not loaded.' };
  try {
    const testClient = window.supabase.createClient(url.trim(), key.trim());
    // Lightweight check — just verify auth config is accessible
    const { error } = await testClient.from('profiles').select('id').limit(1);
    if (error && error.code !== 'PGRST116' && error.code !== '42P01') {
      // 42P01 = table doesn't exist yet (schema not run) — still counts as connected
      return { ok: false, message: error.message };
    }
    saveCredentials(url, key);
    _client = testClient;
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message || 'Network error.' };
  }
}

/* ══════════════════════════════════════════════════
   AUTHENTICATION
══════════════════════════════════════════════════ */

/** Get current session (restores from URL hash on OAuth redirect too) */
export async function getSession() {
  const client = getClient();
  if (!client) return null;
  try {
    const { data: { session } } = await client.auth.getSession();
    return session;
  } catch (e) {
    console.warn('[Auth] getSession failed:', e);
    return null;
  }
}

/** Listen for auth state changes (SIGNED_IN, SIGNED_OUT, etc.) */
export function onAuthChange(callback) {
  const client = getClient();
  if (!client) return () => {};
  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return () => subscription.unsubscribe();
}

/** Google OAuth — redirects to Google, then back to app */
export async function signInWithGoogle() {
  const client = getClient();
  if (!client) throw new Error('Supabase not configured. Please set up the backend first.');
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: { access_type: 'offline', prompt: 'consent' }
    }
  });
  if (error) throw error;
}

/** Email + password sign in */
export async function signInWithEmail(email, password) {
  const client = getClient();
  if (!client) {
    // Local fallback (no Supabase)
    return localSignIn(email, password);
  }
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

/** Email + password sign up */
export async function signUpWithEmail(email, password) {
  const client = getClient();
  if (!client) {
    return localSignUp(email, password);
  }
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  return data.session;
}

/** Sign out */
export async function signOut() {
  const client = getClient();
  if (client) {
    await client.auth.signOut();
  }
  // Always clear local session too
  localStorage.removeItem('tq_local_session');
}

/* ── Local Auth Fallback (when Supabase not configured) ── */
function getLocalAccounts() {
  try { return JSON.parse(localStorage.getItem('tq_local_accounts') || '{}'); }
  catch { return {}; }
}
function saveLocalAccounts(a) { localStorage.setItem('tq_local_accounts', JSON.stringify(a)); }

function makeLocalSession(userId, email) {
  const session = { user: { id: userId, email, user_metadata: {}, app_metadata: {} } };
  localStorage.setItem('tq_local_session', JSON.stringify(session));
  return session;
}

export function getLocalSession() {
  try { return JSON.parse(localStorage.getItem('tq_local_session')); }
  catch { return null; }
}

function localSignUp(email, password) {
  const accounts = getLocalAccounts();
  const key = email.toLowerCase().trim();
  if (accounts[key]) throw new Error('Account already exists. Try logging in.');
  const id = 'local_' + Math.random().toString(36).slice(2, 10);
  accounts[key] = { password, id };
  saveLocalAccounts(accounts);
  return makeLocalSession(id, key);
}

function localSignIn(email, password) {
  const accounts = getLocalAccounts();
  const key = email.toLowerCase().trim();
  const account = accounts[key];
  if (!account || account.password !== password) {
    throw new Error('Invalid email or password.');
  }
  return makeLocalSession(account.id, key);
}

/* ══════════════════════════════════════════════════
   PROFILES TABLE
══════════════════════════════════════════════════ */

/** Check if a profile exists for this user */
export async function getProfile(userId) {
  const client = getClient();
  if (!client) {
    // Local fallback
    try {
      const raw = localStorage.getItem(`tq_profile_${userId}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  const { data, error } = await client
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) { console.warn('[DB] getProfile error:', error); return null; }
  return data;
}

/** Create profile for first-time user */
export async function createProfile(userId, displayName, profilePhoto) {
  const profileData = {
    id: userId,
    display_name: displayName,
    profile_photo: profilePhoto || null,
    is_admin: false
  };

  const client = getClient();
  if (!client) {
    // Local fallback
    localStorage.setItem(`tq_profile_${userId}`, JSON.stringify({
      id: userId,
      display_name: displayName,
      profile_photo: profilePhoto || null,
      is_admin: false
    }));
    return profileData;
  }

  const { data, error } = await client
    .from('profiles')
    .upsert(profileData)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Update profile */
export async function updateProfile(userId, fields) {
  const client = getClient();
  if (!client) {
    // Local fallback
    const existing = JSON.parse(localStorage.getItem(`tq_profile_${userId}`) || '{}');
    const updated = { ...existing, ...fields };
    localStorage.setItem(`tq_profile_${userId}`, JSON.stringify(updated));
    return updated;
  }
  const { data, error } = await client
    .from('profiles')
    .update(fields)
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* ══════════════════════════════════════════════════
   TRIPS TABLE
══════════════════════════════════════════════════ */

/** Get the most recently published trip */
export async function getPublishedTrip() {
  const client = getClient();
  if (!client) {
    // Local fallback
    try {
      const raw = localStorage.getItem('tq_active_trip');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  const { data, error } = await client
    .from('trips')
    .select('*')
    .eq('published', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('[DB] getPublishedTrip error:', error); return null; }
  return data;
}

/** Get all trips (admin use) */
export async function getAllTrips() {
  const client = getClient();
  if (!client) {
    try {
      const raw = localStorage.getItem('tq_all_trips');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  const { data, error } = await client
    .from('trips')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return [];
  return data || [];
}

/** Create or update a trip (admin) */
export async function saveTrip({ id, name, description, startDate, published = false }) {
  const tripData = {
    name,
    description: description || null,
    start_date: startDate || null,
    published
  };

  const client = getClient();
  if (!client) {
    // Local fallback
    const saved = { ...tripData, id: id || ('trip_' + Date.now()) };
    localStorage.setItem('tq_active_trip', JSON.stringify(saved));
    return saved;
  }

  let result;
  if (id) {
    const { data, error } = await client
      .from('trips')
      .update(tripData)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    result = data;
  } else {
    const { data, error } = await client
      .from('trips')
      .insert(tripData)
      .select()
      .single();
    if (error) throw error;
    result = data;
  }
  return result;
}

/** Publish a trip */
export async function publishTrip(tripId) {
  const client = getClient();
  if (!client) {
    // Local fallback
    const raw = localStorage.getItem('tq_active_trip');
    if (raw) {
      const trip = JSON.parse(raw);
      trip.published = true;
      localStorage.setItem('tq_active_trip', JSON.stringify(trip));
      return trip;
    }
    throw new Error('No trip found to publish.');
  }
  const { data, error } = await client
    .from('trips')
    .update({ published: true })
    .eq('id', tripId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* ══════════════════════════════════════════════════
   DESTINATIONS TABLE
══════════════════════════════════════════════════ */

/** Get ordered destinations for a trip */
export async function getDestinations(tripId) {
  const client = getClient();
  if (!client) {
    try {
      const raw = localStorage.getItem(`tq_destinations_${tripId}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  const { data, error } = await client
    .from('destinations')
    .select('*')
    .eq('trip_id', tripId)
    .order('sort_order', { ascending: true });
  if (error) { console.warn('[DB] getDestinations error:', error); return []; }
  return data || [];
}

/** Save all destinations for a trip (replaces existing) */
export async function saveDestinations(tripId, destinations) {
  const client = getClient();
  if (!client) {
    // Local fallback
    const data = destinations.map((d, i) => ({ ...d, trip_id: tripId, sort_order: i, id: d.id || ('dest_' + Date.now() + '_' + i) }));
    localStorage.setItem(`tq_destinations_${tripId}`, JSON.stringify(data));
    return data;
  }

  // Delete existing, then insert new with updated sort_order
  await client.from('destinations').delete().eq('trip_id', tripId);

  if (destinations.length === 0) return [];

  const rows = destinations.map((d, i) => ({
    id: d.id && !d.id.startsWith('tmp_') ? d.id : undefined,
    trip_id: tripId,
    name: d.name,
    description: d.description || null,
    lat: d.lat || null,
    lng: d.lng || null,
    maps_url: d.maps_url || null,
    thumbnail: d.thumbnail || null,
    sort_order: i
  }));

  // Remove undefined id fields
  const cleaned = rows.map(r => {
    if (!r.id) delete r.id;
    return r;
  });

  const { data, error } = await client
    .from('destinations')
    .insert(cleaned)
    .select();
  if (error) throw error;
  return data || [];
}

/* ══════════════════════════════════════════════════
   CHAT MESSAGES TABLE
══════════════════════════════════════════════════ */

/** Fetch last N messages for a trip */
export async function getChatMessages(tripId, limit = 100) {
  const client = getClient();
  if (!client) {
    try {
      const raw = localStorage.getItem(`tq_chat_${tripId}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  const { data, error } = await client
    .from('chat_messages')
    .select('*')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) { console.warn('[DB] getChatMessages error:', error); return []; }
  return data || [];
}

/** Send a chat message */
export async function sendChatMessage(tripId, userId, displayName, profilePhoto, text) {
  const msg = {
    trip_id: tripId,
    user_id: userId,
    display_name: displayName,
    profile_photo: profilePhoto || null,
    text: text.trim()
  };

  const client = getClient();
  if (!client) {
    // Local fallback — store in localStorage
    const msgs = (() => {
      try { return JSON.parse(localStorage.getItem(`tq_chat_${tripId}`) || '[]'); }
      catch { return []; }
    })();
    const newMsg = { ...msg, id: 'local_' + Date.now(), created_at: new Date().toISOString() };
    msgs.push(newMsg);
    // Keep last 200
    if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
    localStorage.setItem(`tq_chat_${tripId}`, JSON.stringify(msgs));
    return newMsg;
  }

  const { data, error } = await client
    .from('chat_messages')
    .insert(msg)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Subscribe to new chat messages (real-time) */
export function subscribeToChatMessages(tripId, onNewMessage) {
  const client = getClient();
  if (!client) return () => {}; // No-op unsubscribe

  const channel = client
    .channel(`chat:${tripId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'chat_messages',
      filter: `trip_id=eq.${tripId}`
    }, (payload) => {
      onNewMessage(payload.new);
    })
    .subscribe();

  return () => {
    channel.unsubscribe();
    client.removeChannel(channel);
  };
}

/** Subscribe to destination changes (real-time — admin publishes, all see it) */
export function subscribeToItinerary(tripId, onUpdate) {
  const client = getClient();
  if (!client) return () => {};

  const channel = client
    .channel(`itinerary:${tripId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'destinations',
      filter: `trip_id=eq.${tripId}`
    }, onUpdate)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'trips',
      filter: `id=eq.${tripId}`
    }, onUpdate)
    .subscribe();

  return () => {
    channel.unsubscribe();
    client.removeChannel(channel);
  };
}
