// Global State Manager for TripQuest
import { travelBingoItems, travelChallenges, secretMissions } from './mockData.js';
import { 
  getSupabaseClient, 
  dbCreateTrip, 
  dbJoinTrip, 
  dbGetTripDetails, 
  dbUpdateTrip, 
  dbUpdatePlayer, 
  dbAddChatMessage, 
  dbAddGalleryPhoto, 
  subscribeToTrip 
} from './supabase.js';

class StateManager {
  constructor() {
    this.storageKey = 'tripquest_state';
    this.currentUserKey = 'tripquest_user';
    this.activeTripKey = 'tripquest_active_trip_code';
    
    this.listeners = [];
    
    // Load local user or default
    this.user = this.loadLocalUser();
    
    // Load database of trips
    this.db = this.loadDB();
    
    // Active trip code
    this.activeTripCode = localStorage.getItem(this.activeTripKey) || null;

    // Load active trip from Supabase if credentials are cached
    this.initSupabaseConnection();
  }

  // Register listener for changes
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  notify() {
    this.saveDB();
    this.listeners.forEach(callback => callback(this.getActiveTrip(), this.user));
  }

  notifyListenersOnly() {
    const active = this.getActiveTrip();
    this.listeners.forEach(callback => callback(active, this.user));
  }

  async initSupabaseConnection() {
    const client = getSupabaseClient();
    if (client && this.activeTripCode) {
      console.log('Loading active trip details from Supabase:', this.activeTripCode);
      const details = await dbGetTripDetails(this.activeTripCode);
      if (details) {
        this.db.trips[this.activeTripCode] = details;
        this.notify();
      }
      this.setupSupabaseSubscription(this.activeTripCode);
    }
  }

  setupSupabaseSubscription(code) {
    subscribeToTrip(code, {
      onTripUpdate: (updated) => {
        const trip = this.db.trips[code];
        if (trip) {
          trip.itinerary = updated.itinerary;
          trip.activeChallenge = updated.active_challenge;
          trip.teams = updated.teams;
          this.notifyListenersOnly();
        }
      },
      onPlayersChange: async () => {
        const details = await dbGetTripDetails(code);
        if (details) {
          this.db.trips[code] = details;
          this.notifyListenersOnly();
        }
      },
      onChatMessage: (newMsg) => {
        const trip = this.db.trips[code];
        if (trip) {
          if (trip.chat.find(c => c.id === newMsg.id)) return;
          trip.chat.push({
            id: newMsg.id,
            sender: newMsg.sender,
            avatar: newMsg.avatar,
            text: newMsg.text,
            timestamp: new Date(newMsg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
          this.notifyListenersOnly();
        }
      },
      onPhotoUploaded: (newPhoto) => {
        const trip = this.db.trips[code];
        if (trip) {
          if (trip.gallery.find(g => g.id === newPhoto.id)) return;
          trip.gallery.unshift({
            id: newPhoto.id,
            url: newPhoto.url,
            caption: newPhoto.caption,
            uploadedBy: newPhoto.uploaded_by,
            category: newPhoto.category,
            timestamp: new Date(newPhoto.created_at).toLocaleDateString()
          });
          this.notifyListenersOnly();
        }
      }
    });
  }

  loadLocalUser() {
    const raw = localStorage.getItem(this.currentUserKey);
    if (raw) {
      return JSON.parse(raw);
    }
    // Create a default guest user until registration
    const defaultUser = {
      id: 'usr_' + Math.random().toString(36).substr(2, 9),
      name: '',
      avatar: '🦊',
      team: 'Red',
      isHost: false
    };
    localStorage.setItem(this.currentUserKey, JSON.stringify(defaultUser));
    return defaultUser;
  }

  saveUser(userData) {
    this.user = { ...this.user, ...userData };
    localStorage.setItem(this.currentUserKey, JSON.stringify(this.user));
    
    // Update active trip's members list if user belongs to it
    const activeTrip = this.getActiveTrip();
    if (activeTrip) {
      const idx = activeTrip.members.findIndex(m => m.id === this.user.id);
      if (idx !== -1) {
        activeTrip.members[idx].name = this.user.name;
        activeTrip.members[idx].avatar = this.user.avatar;
        activeTrip.members[idx].team = this.user.team;
      } else {
        // Add if not present
        activeTrip.members.push({
          id: this.user.id,
          name: this.user.name,
          avatar: this.user.avatar,
          team: this.user.team,
          xp: 0,
          level: 1
        });
      }
      
      const client = getSupabaseClient();
      if (client) {
        dbUpdatePlayer(activeTrip.code, this.user.id, {
          name: this.user.name,
          avatar: this.user.avatar,
          team: this.user.team
        });
      }
      this.notify();
    } else {
      this.saveDB();
    }
  }

  loadDB() {
    const raw = localStorage.getItem(this.storageKey);
    if (raw) {
      return JSON.parse(raw);
    }
    return {
      trips: {}
    };
  }

  saveDB() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.db));
  }

  getActiveTrip() {
    if (!this.activeTripCode) return null;
    return this.db.trips[this.activeTripCode] || null;
  }

  setActiveTripCode(code) {
    this.activeTripCode = code;
    if (code) {
      localStorage.setItem(this.activeTripKey, code);
    } else {
      localStorage.removeItem(this.activeTripKey);
    }
    this.notify();
  }

  createTrip(name, startDate, days, style, destinations) {
    const code = 'QUEST-' + Math.floor(1000 + Math.random() * 9000);
    
    const trip = {
      code,
      name,
      startDate,
      days: parseInt(days),
      style, // relaxed, balanced, packed
      destinations, // Array of places
      itinerary: {}, // Day-by-day itinerary
      members: [
        {
          id: this.user.id,
          name: this.user.name || 'Host Planner',
          avatar: this.user.avatar,
          team: this.user.team,
          xp: 100, // starting points for hosting
          level: 1
        }
      ],
      bingo: {}, // player_id -> array of 25 booleans
      challenges: [...travelChallenges],
      activeChallenge: null, // Current active challenge (wheel output)
      secretMissions: secretMissions.map(m => ({ ...m, completed: false, revealed: false, assignedTo: null })),
      chat: [
        {
          id: 'chat_init',
          sender: 'TripQuest Guide',
          avatar: '🎮',
          text: `Welcome to ${name}! The Quest has begun. Invite your friends using Code: ${code} 🚀`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ],
      gallery: [],
      teams: {
        Red: { score: 100 },
        Blue: { score: 0 }
      }
    };

    // Initialize Host Bingo card
    trip.bingo[this.user.id] = Array(25).fill(false);

    this.db.trips[code] = trip;
    this.activeTripCode = code;
    localStorage.setItem(this.activeTripKey, code);
    this.user.isHost = true;
    this.saveUser({ isHost: true });

    const client = getSupabaseClient();
    if (client) {
      (async () => {
        try {
          await dbCreateTrip(trip);
          await dbJoinTrip(code, {
            id: this.user.id,
            name: this.user.name || 'Host Planner',
            avatar: this.user.avatar,
            team: this.user.team,
            xp: 100,
            level: 1
          });
          this.setupSupabaseSubscription(code);
        } catch (e) {
          console.error('Error writing trip to Supabase:', e);
        }
      })();
    }
    
    this.notify();
    return code;
  }

  async joinTrip(code) {
    const normalizedCode = code.toUpperCase().trim();
    
    const client = getSupabaseClient();
    if (client) {
      try {
        const details = await dbGetTripDetails(normalizedCode);
        if (!details) {
          return { success: false, message: 'Trip Code not found in Supabase!' };
        }

        // Save details locally
        this.db.trips[normalizedCode] = details;

        // Join player
        const myPlayerObj = {
          id: this.user.id,
          name: this.user.name || 'Explorer',
          avatar: this.user.avatar,
          team: this.user.team,
          xp: 0,
          level: 1
        };

        await dbJoinTrip(normalizedCode, myPlayerObj);
        
        // Notify chat
        await dbAddChatMessage(normalizedCode, 'TripQuest Guide', '🎮', `🎉 ${this.user.name || 'New member'} has joined the quest!`);

        this.activeTripCode = normalizedCode;
        localStorage.setItem(this.activeTripKey, normalizedCode);
        this.user.isHost = (details.members.length === 0 || details.members[0].id === this.user.id);
        this.saveUser({ isHost: this.user.isHost });
        
        this.setupSupabaseSubscription(normalizedCode);
        this.notify();
        return { success: true, trip: details };
      } catch (e) {
        return { success: false, message: e.message || 'Error connecting to Supabase room.' };
      }
    }

    // Local fallback join
    const trip = this.db.trips[normalizedCode];
    if (!trip) {
      return { success: false, message: 'Trip Code not found!' };
    }

    // Add user to members if not already there
    const exists = trip.members.find(m => m.id === this.user.id);
    if (!exists) {
      trip.members.push({
        id: this.user.id,
        name: this.user.name || 'Explorer',
        avatar: this.user.avatar,
        team: this.user.team,
        xp: 0,
        level: 1
      });
      trip.bingo[this.user.id] = Array(25).fill(false);
      
      // Auto assign a secret mission
      const unassignedMissions = trip.secretMissions.filter(m => !m.assignedTo);
      if (unassignedMissions.length > 0) {
        const randMission = unassignedMissions[Math.floor(Math.random() * unassignedMissions.length)];
        randMission.assignedTo = this.user.id;
      }

      this.addChatMessage('TripQuest Guide', '🎮', `🎉 ${this.user.name || 'New member'} has joined the quest!`, normalizedCode);
    }

    this.activeTripCode = normalizedCode;
    localStorage.setItem(this.activeTripKey, normalizedCode);
    this.user.isHost = (trip.members[0].id === this.user.id);
    this.saveUser({ isHost: this.user.isHost });
    
    this.notify();
    return { success: true, trip };
  }

  leaveTrip() {
    const activeTrip = this.getActiveTrip();
    if (activeTrip) {
      // Keep host or let users leave
      activeTrip.members = activeTrip.members.filter(m => m.id !== this.user.id);
      this.addChatMessage('TripQuest Guide', '🎮', `👋 ${this.user.name || 'A player'} left the trip.`, activeTrip.code);
    }
    this.activeTripCode = null;
    localStorage.removeItem(this.activeTripKey);
    this.user.isHost = false;
    this.saveUser({ isHost: false });
    this.notify();
  }

  addChatMessage(sender, avatar, text, tripCode = null) {
    const code = tripCode || this.activeTripCode;
    const client = getSupabaseClient();
    if (client) {
      dbAddChatMessage(code, sender, avatar, text);
      return;
    }

    const trip = this.db.trips[code];
    if (!trip) return;

    const message = {
      id: 'msg_' + Math.random().toString(36).substr(2, 9),
      sender,
      avatar,
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    trip.chat.push(message);
    if (trip.chat.length > 100) trip.chat.shift();
    this.notify();
  }

  addXP(points, playerId = null) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    const targetId = playerId || this.user.id;
    const member = activeTrip.members.find(m => m.id === targetId);
    if (member) {
      member.xp += points;
      member.level = Math.floor(member.xp / 300) + 1;
      
      const team = member.team || 'Red';
      if (!activeTrip.teams[team]) activeTrip.teams[team] = { score: 0 };
      activeTrip.teams[team].score += points;

      const client = getSupabaseClient();
      if (client) {
        dbUpdatePlayer(activeTrip.code, targetId, { xp: member.xp, level: member.level });
        dbUpdateTrip(activeTrip.code, { teams: activeTrip.teams });
      }
      this.notify();
    }
  }

  toggleBingoTile(index) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    const userBingo = activeTrip.bingo[this.user.id];
    if (!userBingo) return;

    userBingo[index] = !userBingo[index];

    const client = getSupabaseClient();
    if (client) {
      dbUpdatePlayer(activeTrip.code, this.user.id, { bingoCard: userBingo });
    }
    
    if (userBingo[index]) {
      this.addXP(30);
      this.addChatMessage('TripQuest Guide', '🎮', `🎯 ${this.user.name} checked off Bingo tile: "${travelBingoItems[index]}" (+30 XP)`);
      
      if (this.checkBingoWin(userBingo)) {
        this.addXP(100);
        this.addChatMessage('TripQuest Guide', '🎉', `👑 BINGO! ${this.user.name} completed a line on their bingo card! (+100 XP)`);
      }
    } else {
      this.addXP(-30);
    }
    this.notify();
  }

  checkBingoWin(grid) {
    // 5x5 check
    for (let r = 0; r < 5; r++) {
      if (grid[r*5] && grid[r*5+1] && grid[r*5+2] && grid[r*5+3] && grid[r*5+4]) return true;
    }
    for (let c = 0; c < 5; c++) {
      if (grid[c] && grid[c+5] && grid[c+10] && grid[c+15] && grid[c+20]) return true;
    }
    if (grid[0] && grid[6] && grid[12] && grid[18] && grid[24]) return true;
    if (grid[4] && grid[8] && grid[12] && grid[16] && grid[20]) return true;

    return false;
  }

  spinWheelAssign(challengeId, selectedPlayerId) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    const challenge = activeTrip.challenges.find(c => c.id === challengeId);
    const player = activeTrip.members.find(m => m.id === selectedPlayerId);
    if (challenge && player) {
      const activeChallenge = {
        challengeId,
        title: challenge.title,
        icon: challenge.icon,
        assignedToId: selectedPlayerId,
        assignedToName: player.name,
        assignedToAvatar: player.avatar,
        points: challenge.points,
        completed: false
      };
      
      activeTrip.activeChallenge = activeChallenge;

      const client = getSupabaseClient();
      if (client) {
        dbUpdateTrip(activeTrip.code, { activeChallenge });
      }
      
      this.addChatMessage('TripQuest Spin', '🎡', `🎡 The Wheel has spoken! ${player.name} is assigned to: "${challenge.title}" for ${challenge.points} XP!`);
      this.notify();
    }
  }

  completeActiveChallenge(proofUrl = null) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip || !activeTrip.activeChallenge) return;

    const active = activeTrip.activeChallenge;
    active.completed = true;

    // Credit player
    this.addXP(active.points, active.assignedToId);

    // Save proof to media gallery
    if (proofUrl) {
      const client = getSupabaseClient();
      if (client) {
        dbAddGalleryPhoto(activeTrip.code, proofUrl, `Challenge: ${active.title}`, active.assignedToName, 'Challenge');
      } else {
        this.addGalleryPhoto(proofUrl, `Challenge: ${active.title}`, active.assignedToName, 'Challenge');
      }
    }

    this.addChatMessage('TripQuest Guide', '🏆', `🏆 Challenge Completed! ${active.assignedToName} finished "${active.title}" (+${active.points} XP)`);
    
    activeTrip.activeChallenge = null;
    const client = getSupabaseClient();
    if (client) {
      dbUpdateTrip(activeTrip.code, { activeChallenge: null });
    }
    this.notify();
  }

  claimSecretMission(missionId) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    const mission = activeTrip.secretMissions.find(m => m.id === missionId);
    if (mission && mission.assignedTo === this.user.id && !mission.completed) {
      mission.completed = true;
      mission.revealed = true;

      const client = getSupabaseClient();
      if (client) {
        dbUpdatePlayer(activeTrip.code, this.user.id, { secretMissionCompleted: true });
      }

      this.addXP(mission.points);
      this.addChatMessage('TripQuest Guide', '🤫', `🤫 Secret Mission accomplished by ${this.user.name}: "${mission.title}" (+${mission.points} XP)`);
      this.notify();
    }
  }

  addGalleryPhoto(url, caption, uploader = null, category = 'General') {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    const client = getSupabaseClient();
    if (client) {
      dbAddGalleryPhoto(activeTrip.code, url, caption, uploader || this.user.name, category);
      return;
    }

    const photo = {
      id: 'photo_' + Math.random().toString(36).substr(2, 9),
      url,
      caption,
      uploadedBy: uploader || this.user.name || 'Explorer',
      category,
      timestamp: new Date().toLocaleDateString()
    };

    activeTrip.gallery.unshift(photo);
    this.notify();
  }

  checkInDestination(day, placeIndex) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    const daySchedule = activeTrip.itinerary[day];
    if (!daySchedule || !daySchedule[placeIndex]) return;

    const item = daySchedule[placeIndex];
    item.completed = !item.completed;

    const client = getSupabaseClient();
    if (client) {
      dbUpdateTrip(activeTrip.code, { itinerary: activeTrip.itinerary });
    }

    if (item.completed) {
      this.addXP(50); // XP for checking in
      this.addChatMessage('TripQuest Guide', '📍', `📍 Visited ${item.name}! Check-in completed. (+50 XP)`);
    } else {
      this.addXP(-50);
    }
    this.notify();
  }

  updateItinerary(day, schedule) {
    const activeTrip = this.getActiveTrip();
    if (!activeTrip) return;

    activeTrip.itinerary[day] = schedule;

    const client = getSupabaseClient();
    if (client) {
      dbUpdateTrip(activeTrip.code, { itinerary: activeTrip.itinerary });
    }
    this.notify();
  }

  // Cross-Tab Sync receiver
  syncStateFromExternal(externalDB) {
    // If Supabase is connected, ignore LocalStorage database sync to avoid cross-firing
    if (getSupabaseClient()) return;

    this.db = externalDB;
    this.saveDB();
    const activeTrip = this.getActiveTrip();
    if (activeTrip) {
      const idx = activeTrip.members.findIndex(m => m.id === this.user.id);
      if (idx !== -1) {
        this.user.isHost = (activeTrip.members[0].id === this.user.id);
      }
    }
    this.listeners.forEach(callback => callback(activeTrip, this.user));
  }
}

export const state = new StateManager();
