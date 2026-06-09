// ═══════════════════════════════════════════════════════════
// TripQuest · Simplified Supabase & LocalStorage Interface
// ═══════════════════════════════════════════════════════════

let _client = null;

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

export function getClient() {
  if (_client) return _client;
  const { url, key } = getCredentials();
  if (!url || !key || !window.supabase) return null;
  try {
    _client = window.supabase.createClient(url, key);
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

export async function testConnection(url, key) {
  if (!window.supabase) return { ok: false, message: 'Supabase library not loaded.' };
  try {
    const testClient = window.supabase.createClient(url.trim(), key.trim());
    // Try to query the trips table to verify connection
    const { error } = await testClient.from('trips').select('id').limit(1);
    if (error && error.code !== 'PGRST116' && error.code !== '42P01') {
      return { ok: false, message: error.message };
    }
    saveCredentials(url, key);
    _client = testClient;
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message || 'Network error.' };
  }
}

// ══════════════════════════════════════════════════
// DATABASE OPERATIONS
// ══════════════════════════════════════════════════

/** Load the active trip */
export async function loadActiveTrip() {
  // Always fetch local backup first as fallback
  let localTrip = null;
  try {
    const raw = localStorage.getItem('tq_active_trip');
    if (raw) localTrip = JSON.parse(raw);
  } catch (e) {
    console.warn('[LocalStorage] failed to load trip', e);
  }

  const client = getClient();
  if (!client) return localTrip;

  try {
    const { data, error } = await client
      .from('trips')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) {
      // Sync to local
      localStorage.setItem('tq_active_trip', JSON.stringify(data));
      return data;
    }
  } catch (err) {
    console.warn('[Supabase] loadActiveTrip failed, using local fallback:', err);
  }
  return localTrip;
}

/** Save or update the active trip */
export async function saveActiveTrip(tripObj) {
  // Save locally first
  localStorage.setItem('tq_active_trip', JSON.stringify(tripObj));

  const client = getClient();
  if (!client) return tripObj;

  try {
    const { data, error } = await client
      .from('trips')
      .upsert({
        id: tripObj.id,
        name: tripObj.name,
        description: tripObj.description || '',
        published: true
      })
      .select()
      .single();

    if (error) throw error;
    if (data) {
      localStorage.setItem('tq_active_trip', JSON.stringify(data));
      return data;
    }
  } catch (err) {
    console.error('[Supabase] saveActiveTrip failed:', err);
  }
  return tripObj;
}

/** Load destinations for a trip */
export async function loadDestinations(tripId) {
  let localDests = [];
  try {
    const raw = localStorage.getItem(`tq_destinations_${tripId}`);
    if (raw) localDests = JSON.parse(raw);
  } catch (e) {
    console.warn('[LocalStorage] failed to load destinations', e);
  }

  const client = getClient();
  if (!client) return localDests;

  try {
    const { data, error } = await client
      .from('destinations')
      .select('*')
      .eq('trip_id', tripId)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    if (data) {
      localStorage.setItem(`tq_destinations_${tripId}`, JSON.stringify(data));
      return data;
    }
  } catch (err) {
    console.warn('[Supabase] loadDestinations failed, using local fallback:', err);
  }
  return localDests;
}

/** Overwrite and save destinations for a trip */
export async function saveDestinations(tripId, destsArray) {
  // Format for DB mapping
  const formattedDests = destsArray.map((d, index) => ({
    id: d.id.startsWith('tmp_') ? undefined : d.id, // let Supabase generate UUID if temp
    trip_id: tripId,
    name: d.name,
    description: d.description || '',
    lat: d.lat,
    lng: d.lng,
    maps_url: d.maps_url || '',
    thumbnail: d.thumbnail || '',
    category: d.category || 'Attraction',
    time: d.time || '',
    duration: parseInt(d.duration) || 60,
    sort_order: index
  }));

  // Save locally
  localStorage.setItem(`tq_destinations_${tripId}`, JSON.stringify(formattedDests));

  const client = getClient();
  if (!client) return formattedDests;

  try {
    // 1. Delete existing destinations
    const { error: delError } = await client
      .from('destinations')
      .delete()
      .eq('trip_id', tripId);

    if (delError) throw delError;

    // 2. Insert new destinations
    if (formattedDests.length > 0) {
      const { data, error: insError } = await client
        .from('destinations')
        .insert(formattedDests)
        .select();

      if (insError) throw insError;
      if (data) {
        localStorage.setItem(`tq_destinations_${tripId}`, JSON.stringify(data));
        return data;
      }
    }
  } catch (err) {
    console.error('[Supabase] saveDestinations failed:', err);
  }
  return formattedDests;
}
