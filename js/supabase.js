// Supabase Database and Real-time Subscription Manager
let supabaseClient = null;
let activeChannels = [];

export const supabaseConfig = {
  urlKey: 'tripquest_supabase_url',
  anonKey: 'tripquest_supabase_anon_key',
  
  getCredentials() {
    return {
      url: localStorage.getItem(this.urlKey) || '',
      key: localStorage.getItem(this.anonKey) || ''
    };
  },
  
  saveCredentials(url, key) {
    if (url && key) {
      localStorage.setItem(this.urlKey, url.trim());
      localStorage.setItem(this.anonKey, key.trim());
    } else {
      localStorage.removeItem(this.urlKey);
      localStorage.removeItem(this.anonKey);
    }
  }
};

export function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  
  const creds = supabaseConfig.getCredentials();
  if (creds.url && creds.key && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(creds.url, creds.key);
      return supabaseClient;
    } catch (e) {
      console.error('Error initializing Supabase client:', e);
      return null;
    }
  }
  return null;
}

export async function testConnection(url, key) {
  if (!window.supabase) return { success: false, message: 'Supabase library not loaded yet!' };
  try {
    const testClient = window.supabase.createClient(url.trim(), key.trim());
    // Try a simple read from trips table to check auth/URL validity
    const { data, error } = await testClient.from('trips').select('code').limit(1);
    
    if (error && error.code !== 'PGRST116') { // PGRST116 is 'no rows returned', which means table exists and auth works!
      return { success: false, message: error.message };
    }
    
    // Auth works, cache keys
    supabaseConfig.saveCredentials(url, key);
    supabaseClient = testClient;
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message || 'Network error connecting to Supabase.' };
  }
}

export function disconnectSupabase() {
  unsubscribeAll();
  supabaseClient = null;
  supabaseConfig.saveCredentials('', '');
}

export function unsubscribeAll() {
  activeChannels.forEach(channel => {
    try {
      channel.unsubscribe();
    } catch (e) {
      console.warn('Error unsubscribing channel:', e);
    }
  });
  activeChannels = [];
}

/* REAL-TIME SUBSCRIPTIONS */

export function subscribeToTrip(tripCode, callbacks) {
  const client = getSupabaseClient();
  if (!client) return;

  unsubscribeAll();

  // Create a channel for real-time Postgres changes filtered by tripCode
  const channel = client.channel(`trip-room:${tripCode}`)
    // Listen to trip updates (itinerary, active challenge, team scores)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'trips',
      filter: `code=eq.${tripCode}`
    }, payload => {
      if (callbacks.onTripUpdate) callbacks.onTripUpdate(payload.new);
    })
    // Listen to changes in players (leaderboard, bingo)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'players',
      filter: `trip_code=eq.${tripCode}`
    }, payload => {
      if (callbacks.onPlayersChange) callbacks.onPlayersChange(payload);
    })
    // Listen to new chat messages
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'chat_messages',
      filter: `trip_code=eq.${tripCode}`
    }, payload => {
      if (callbacks.onChatMessage) callbacks.onChatMessage(payload.new);
    })
    // Listen to new photo uploads
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'gallery_photos',
      filter: `trip_code=eq.${tripCode}`
    }, payload => {
      if (callbacks.onPhotoUploaded) callbacks.onPhotoUploaded(payload.new);
    })
    .subscribe((status) => {
      console.log(`Supabase Subscription Status for ${tripCode}:`, status);
    });

  activeChannels.push(channel);
}

/* DATABASE ACCESS WRITES */

export async function dbCreateTrip(trip) {
  const client = getSupabaseClient();
  if (!client) return null;

  // Insert trip row
  const { error } = await client.from('trips').insert({
    code: trip.code,
    name: trip.name,
    start_date: trip.startDate,
    days: trip.days,
    style: trip.style,
    destinations: trip.destinations,
    itinerary: trip.itinerary,
    active_challenge: trip.activeChallenge,
    teams: trip.teams
  });

  if (error) throw error;
  return trip.code;
}

export async function dbJoinTrip(tripCode, player) {
  const client = getSupabaseClient();
  if (!client) return null;

  // Check if player already exists in the room
  const { data: existing } = await client
    .from('players')
    .select('id')
    .eq('trip_code', tripCode)
    .eq('id', player.id)
    .maybeSingle();

  if (!existing) {
    const { error } = await client.from('players').insert({
      id: player.id,
      trip_code: tripCode,
      name: player.name,
      avatar: player.avatar,
      team: player.team,
      xp: player.xp || 0,
      level: player.level || 1,
      bingo_card: Array(25).fill(false),
      secret_mission_id: player.secretMissionId || '',
      secret_mission_completed: false
    });
    if (error) throw error;
  }
}

export async function dbGetTripDetails(tripCode) {
  const client = getSupabaseClient();
  if (!client) return null;

  // Fetch trip info
  const { data: trip, error: tripErr } = await client
    .from('trips')
    .select('*')
    .eq('code', tripCode)
    .single();

  if (tripErr) return null;

  // Fetch players list
  const { data: players } = await client
    .from('players')
    .select('*')
    .eq('trip_code', tripCode);

  // Fetch chats
  const { data: chat } = await client
    .from('chat_messages')
    .select('*')
    .eq('trip_code', tripCode)
    .order('created_at', { ascending: true })
    .limit(100);

  // Fetch gallery photos
  const { data: gallery } = await client
    .from('gallery_photos')
    .select('*')
    .eq('trip_code', tripCode)
    .order('created_at', { ascending: false });

  // Map to matching client representation
  return {
    code: trip.code,
    name: trip.name,
    startDate: trip.start_date,
    days: trip.days,
    style: trip.style,
    destinations: trip.destinations,
    itinerary: trip.itinerary,
    activeChallenge: trip.active_challenge,
    teams: trip.teams,
    members: (players || []).map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      team: p.team,
      xp: p.xp,
      level: p.level,
      secretMissionId: p.secret_mission_id,
      secretMissionCompleted: p.secret_mission_completed
    })),
    bingo: (players || []).reduce((acc, p) => {
      acc[p.id] = p.bingo_card;
      return acc;
    }, {}),
    chat: (chat || []).map(c => ({
      id: c.id,
      sender: c.sender,
      avatar: c.avatar,
      text: c.text,
      timestamp: new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    })),
    gallery: (gallery || []).map(g => ({
      id: g.id,
      url: g.url,
      caption: g.caption,
      uploadedBy: g.uploaded_by,
      category: g.category,
      timestamp: new Date(g.created_at).toLocaleDateString()
    }))
  };
}

export async function dbUpdateTrip(tripCode, fields) {
  const client = getSupabaseClient();
  if (!client) return;

  const updateObj = {};
  if (fields.itinerary !== undefined) updateObj.itinerary = fields.itinerary;
  if (fields.activeChallenge !== undefined) updateObj.active_challenge = fields.activeChallenge;
  if (fields.teams !== undefined) updateObj.teams = fields.teams;

  if (Object.keys(updateObj).length > 0) {
    const { error } = await client.from('trips').update(updateObj).eq('code', tripCode);
    if (error) console.error('Error updating Supabase trip:', error);
  }
}

export async function dbUpdatePlayer(tripCode, playerId, fields) {
  const client = getSupabaseClient();
  if (!client) return;

  const updateObj = {};
  if (fields.name !== undefined) updateObj.name = fields.name;
  if (fields.avatar !== undefined) updateObj.avatar = fields.avatar;
  if (fields.team !== undefined) updateObj.team = fields.team;
  if (fields.xp !== undefined) updateObj.xp = fields.xp;
  if (fields.level !== undefined) updateObj.level = fields.level;
  if (fields.bingoCard !== undefined) updateObj.bingo_card = fields.bingoCard;
  if (fields.secretMissionId !== undefined) updateObj.secret_mission_id = fields.secretMissionId;
  if (fields.secretMissionCompleted !== undefined) updateObj.secret_mission_completed = fields.secretMissionCompleted;

  if (Object.keys(updateObj).length > 0) {
    const { error } = await client
      .from('players')
      .update(updateObj)
      .eq('trip_code', tripCode)
      .eq('id', playerId);
    if (error) console.error('Error updating Supabase player:', error);
  }
}

export async function dbAddChatMessage(tripCode, sender, avatar, text) {
  const client = getSupabaseClient();
  if (!client) return;

  const { error } = await client.from('chat_messages').insert({
    trip_code: tripCode,
    sender,
    avatar,
    text
  });
  if (error) console.error('Error adding Supabase chat message:', error);
}

export async function dbAddGalleryPhoto(tripCode, url, caption, uploadedBy, category) {
  const client = getSupabaseClient();
  if (!client) return;

  const { error } = await client.from('gallery_photos').insert({
    trip_code: tripCode,
    url,
    caption,
    uploaded_by: uploadedBy,
    category
  });
  if (error) console.error('Error adding Supabase gallery photo:', error);
}
