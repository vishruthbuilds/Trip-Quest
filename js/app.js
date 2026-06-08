// Core UI Orchestrator for TripQuest
import { state } from './state.js';
import { initializeSync } from './sync.js';
import { googleMapsLists } from './mockData.js';
import { generateItinerary, recalculateDaySchedule, suggestAdjustmentForDelay } from './itinerary.js';
import { initMap, drawItineraryRoute, drawUserPins, panToCoords } from './maps.js';
import { renderBingoBoard, SpinWheel, triggerConfetti } from './game.js';
import { testConnection, supabaseConfig, disconnectSupabase, getSupabaseClient } from './supabase.js';

let spinWheel = null;
let activeDay = 1;

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Cross-Tab synchronization
  initializeSync();

  // Create SpinWheel Instance
  spinWheel = new SpinWheel('spinCanvas', 'btn-spin-wheel', 'spin-result-container');

  // Bind Initial UI Events
  bindOnboardingEvents();
  bindHostPlannerEvents();
  bindBottomNavEvents();
  bindChatEvents();
  bindGameEvents();
  bindGalleryEvents();
  bindSimulationEvents();
  bindOverlayEvents();
  bindSupabaseEvents();

  // Update Supabase connection badge on load
  const client = getSupabaseClient();
  if (client) {
    document.getElementById('header-supabase-btn').classList.add('supabase-connected-badge');
  }

  // Subscribe state updates to hot-reload screens
  state.subscribe((trip, user) => {
    updateHeaderUI(trip, user);
    
    // If active trip exists, show Dashboard or route to it
    if (trip) {
      document.getElementById('room-code-tag').innerText = `CODE: ${trip.code}`;
      
      // If we are still on welcome/join screen, route to room
      const activeScreen = document.querySelector('.screen.active');
      if (activeScreen.id === 'screen-welcome' || activeScreen.id === 'screen-join' || activeScreen.id === 'screen-host') {
        showScreen('screen-room');
        showTab('itinerary');
      }

      // Hot reload active tabs
      reloadCurrentTabUI(trip, user);
    } else {
      // If trip deleted or left, send to welcome screen
      const activeScreen = document.querySelector('.screen.active');
      if (activeScreen && activeScreen.id === 'screen-room') {
        showScreen('screen-welcome');
        document.getElementById('bottom-nav').style.display = 'none';
        document.getElementById('header-leave-btn').style.display = 'none';
      }
    }
  });

  // Listen for multi-tab sync actions for real-time sound/alerts
  window.addEventListener('tripquest_synced', (e) => {
    showToast('⚡ Real-time Update', 'Data synchronized with group members!', 'success');
  });

  // Check if there's already an active trip running
  const activeTrip = state.getActiveTrip();
  if (activeTrip) {
    state.notify();
  }
});

/* UI Routing Framework */

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add('active');
    
    // Bottom nav visibility
    const bottomNav = document.getElementById('bottom-nav');
    if (screenId === 'screen-room') {
      bottomNav.style.display = 'flex';
      document.getElementById('header-leave-btn').style.display = 'flex';
    } else {
      bottomNav.style.display = 'none';
      document.getElementById('header-leave-btn').style.display = 'none';
    }
  }
}

function showTab(tabId) {
  // Update Bottom Nav Styling
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    }
  });

  // Show/Hide section divs
  const sections = ['section-itinerary', 'section-play', 'section-chat', 'section-memories', 'section-leaderboard'];
  sections.forEach(secId => {
    const el = document.getElementById(secId);
    if (el) {
      if (secId === `section-${tabId}`) {
        el.style.display = 'flex';
        // Map requires re-render invalidation when shown in tabs
        if (tabId === 'itinerary') {
          setTimeout(triggerMapRedraw, 100);
        }
      } else {
        el.style.display = 'none';
      }
    }
  });

  // Trigger UI populate
  const trip = state.getActiveTrip();
  if (trip) {
    reloadCurrentTabUI(trip, state.user);
  }
}

function triggerMapRedraw() {
  const trip = state.getActiveTrip();
  if (trip) {
    initMap('map');
    const dayPlaces = trip.itinerary[activeDay] || [];
    drawItineraryRoute(dayPlaces);
    drawUserPins(trip.members, dayPlaces);
  }
}

function reloadCurrentTabUI(trip, user) {
  const activeNav = document.querySelector('.nav-item.active');
  const tabId = activeNav ? activeNav.getAttribute('data-tab') : 'itinerary';

  switch (tabId) {
    case 'itinerary':
      populateItineraryUI(trip, user);
      break;
    case 'play':
      populatePlayUI(trip, user);
      break;
    case 'chat':
      populateChatUI(trip, user);
      break;
    case 'memories':
      populateMemoriesUI(trip, user);
      break;
    case 'leaderboard':
      populateLeaderboardUI(trip, user);
      break;
  }
}

/* Onboarding Screen & Registration (Welcome View) */

function bindOnboardingEvents() {
  // Avatar Selection
  const avatarOpts = document.querySelectorAll('.avatar-opt');
  avatarOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      avatarOpts.forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      const avatar = opt.getAttribute('data-avatar');
      state.saveUser({ avatar });
    });
  });

  // Team Selection
  const teamBtns = document.querySelectorAll('.team-btn');
  teamBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      teamBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const team = btn.getAttribute('data-team');
      state.saveUser({ team });
    });
  });

  // Host button click
  document.getElementById('btn-goto-host').addEventListener('click', () => {
    const nameInput = document.getElementById('username-input').value.trim();
    if (!nameInput) {
      showToast('⚠️ Profile Setup', 'Please enter a nickname first!', 'warning');
      return;
    }
    state.saveUser({ name: nameInput });
    showScreen('screen-host');
  });

  // Join screen route button
  document.getElementById('btn-goto-join').addEventListener('click', () => {
    const nameInput = document.getElementById('username-input').value.trim();
    if (!nameInput) {
      showToast('⚠️ Profile Setup', 'Please enter a nickname first!', 'warning');
      return;
    }
    state.saveUser({ name: nameInput });
    showScreen('screen-join');
  });

  // Back from join
  document.getElementById('btn-join-back').addEventListener('click', () => {
    showScreen('screen-welcome');
  });

  // Submit Join Trip
  document.getElementById('btn-submit-join').addEventListener('click', () => {
    const code = document.getElementById('join-code-input').value.toUpperCase().trim();
    if (!code) {
      showToast('⚠️ Code Required', 'Please enter a valid trip code.', 'warning');
      return;
    }

    // Show loading indicator toast
    showToast('🔑 Joining Room', 'Connecting to database...', 'info');

    state.joinTrip(code).then(res => {
      if (res.success) {
        showToast('🎉 Joined Room', `Connected to ${res.trip.name}!`, 'success');
        triggerConfetti();
      } else {
        showToast('❌ Not Found', res.message, 'warning');
      }
    }).catch(err => {
      showToast('❌ Error Joining', err.message || 'Network error.', 'warning');
    });
  });
}

/* Host Trip Creator & Google Import */

let selectedImportList = null;

function bindHostPlannerEvents() {
  document.getElementById('btn-host-back').addEventListener('click', () => {
    showScreen('screen-welcome');
  });

  // Simulated Google Login
  const googleBtn = document.getElementById('btn-google-login');
  googleBtn.addEventListener('click', () => {
    googleBtn.innerHTML = '🔄 Syncing lists...';
    googleBtn.disabled = true;

    setTimeout(() => {
      // Hide auth login card, reveal list selector picker
      document.getElementById('google-auth-card').style.display = 'none';
      const pickerCard = document.getElementById('list-picker-card');
      pickerCard.style.display = 'block';
      
      const listContainer = document.getElementById('maps-lists-container');
      listContainer.innerHTML = '';

      Object.entries(googleMapsLists).forEach(([key, val]) => {
        const item = document.createElement('div');
        item.className = 'list-picker-item';
        item.setAttribute('data-list-key', key);
        item.innerHTML = `
          <div class="list-picker-check">📍</div>
          <div class="list-picker-details">
            <h4>${val.name}</h4>
            <p>Created by: ${val.creator} • ${val.places.length} Saved Places</p>
          </div>
        `;

        item.addEventListener('click', () => {
          document.querySelectorAll('.list-picker-item').forEach(li => li.classList.remove('selected'));
          item.classList.add('selected');
          selectedImportList = key;
        });

        listContainer.appendChild(item);
      });

      // Highlight the first list by default
      const firstItem = listContainer.querySelector('.list-picker-item');
      if (firstItem) {
        firstItem.click();
      }

      showToast('🔐 Google Maps Import', 'Successfully fetched saved lists!', 'success');
    }, 1200);
  });

  // Generate Itinerary Event
  document.getElementById('btn-generate-itinerary').addEventListener('click', () => {
    const tripName = document.getElementById('trip-name-input').value.trim() || 'Adventure Trip';
    const days = parseInt(document.getElementById('trip-days-input').value) || 3;
    const date = document.getElementById('trip-date-input').value;
    const style = document.getElementById('travel-style-select').value;

    if (!selectedImportList) {
      showToast('⚠️ Import Needed', 'Please connect Google Account and select a saved list first!', 'warning');
      return;
    }

    const importData = googleMapsLists[selectedImportList];
    
    // Create loading modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'overlay active';
    overlay.style.zIndex = '3000';
    overlay.innerHTML = `
      <div class="modal" style="text-align: center;">
        <h2 style="margin-bottom: 12px; color: var(--primary);">🤖 TripQuest AI Planner</h2>
        <div style="font-size: 32px; animation: float 1.5s ease-in-out infinite;">🧭</div>
        <p style="margin-top: 14px; font-size: 13px; color: var(--text-muted);">
          Analyzing coordinates, calculating routes, clustering sights, and checking opening hours...
        </p>
        <div style="width: 100%; height: 8px; background: #222; border-radius: 4px; overflow: hidden; margin-top: 16px;">
          <div id="ai-progress-bar" style="width: 0%; height: 100%; background: var(--primary); transition: width 0.1s;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let progress = 0;
    const progBar = overlay.querySelector('#ai-progress-bar');
    const interval = setInterval(() => {
      progress += 10;
      if (progBar) progBar.style.width = `${progress}%`;

      if (progress >= 100) {
        clearInterval(interval);
        document.body.removeChild(overlay);

        // Generate schedule
        const daySchedule = generateItinerary(importData.places, days, style);

        // Create trip room in State
        const code = state.createTrip(tripName, date, days, style, importData.places);
        
        // Save generated itinerary schedule structure
        const activeTrip = state.getActiveTrip();
        if (activeTrip) {
          activeTrip.itinerary = daySchedule;
          state.notify();
        }

        showToast('✨ Quest Map Built', 'Your interactive itinerary was optimized!', 'success');
        triggerConfetti();
        showScreen('screen-room');
        showTab('itinerary');
      }
    }, 200);
  });
}

/* Navigation tabs & general Header */

function bindBottomNavEvents() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.getAttribute('data-tab');
      showTab(tab);
    });
  });

  // Leave Trip button
  document.getElementById('header-leave-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to leave this Trip Quest room? Your stats will be saved locally.')) {
      state.leaveTrip();
    }
  });

  // Help button
  document.getElementById('header-help-btn').addEventListener('click', () => {
    document.getElementById('help-overlay').classList.add('active');
  });
  
  document.getElementById('btn-help-close').addEventListener('click', () => {
    document.getElementById('help-overlay').classList.remove('active');
  });
}

function updateHeaderUI(trip, user) {
  const leaveBtn = document.getElementById('header-leave-btn');
  if (trip) {
    leaveBtn.style.display = 'flex';
  } else {
    leaveBtn.style.display = 'none';
  }
}

/* Itinerary & Leaflet Maps Screen Rendering */

function populateItineraryUI(trip, user) {
  // Day Selector tabs
  const tabContainer = document.getElementById('day-tabs-container');
  tabContainer.innerHTML = '';

  for (let d = 1; d <= trip.days; d++) {
    const tab = document.createElement('div');
    tab.className = `day-tab ${activeDay === d ? 'active' : ''}`;
    tab.innerText = `Day ${d}`;
    tab.addEventListener('click', () => {
      activeDay = d;
      populateItineraryUI(trip, user);
      
      // Update Map elements
      const dayPlaces = trip.itinerary[d] || [];
      drawItineraryRoute(dayPlaces);
      drawUserPins(trip.members, dayPlaces);
    });
    tabContainer.appendChild(tab);
  }

  // Populate list cards
  const listContainer = document.getElementById('itinerary-list-container');
  listContainer.innerHTML = '';

  const dayPlaces = trip.itinerary[activeDay] || [];
  if (dayPlaces.length === 0) {
    listContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 24px; font-size: 13px;">No activities scheduled. Add places to begin!</div>';
    return;
  }

  dayPlaces.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = `itinerary-card ${item.completed ? 'completed' : ''}`;
    
    // Sort ordering controls for Host planner (Move Up / Down reordering)
    let sortControlsHTML = '';
    if (user.isHost) {
      sortControlsHTML = `
        <div style="display: flex; flex-direction: column; justify-content: center; gap: 4px; padding-left: 8px; border-left: 1px dashed #28284E;">
          <button class="sort-btn up" data-idx="${index}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px;">▲</button>
          <button class="sort-btn down" data-idx="${index}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px;">▼</button>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-time-block">
        <span class="time-start">${item.time}</span>
        <span class="time-duration">${item.duration}m</span>
      </div>
      <div class="card-info-block" style="cursor: pointer;">
        <div class="card-info-title">${item.name}</div>
        <div class="card-rating-block">⭐ ${item.rating || '4.0'} • ${item.category || 'Sight'}</div>
        <div class="card-info-desc">${item.description || ''}</div>
        ${item.warning ? `<span class="delay-warning-badge">${item.warningMsg}</span>` : ''}
      </div>
      <button class="itinerary-check-btn" title="Mark Visited">✓</button>
      ${sortControlsHTML}
    `;

    // Fly to coordinates on info click
    card.querySelector('.card-info-block').addEventListener('click', () => {
      panToCoords(item.lat, item.lng);
    });

    // Check-in trigger
    card.querySelector('.itinerary-check-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      state.checkInDestination(activeDay, index);
    });

    // Sort up click
    if (user.isHost) {
      card.querySelector('.sort-btn.up').addEventListener('click', (e) => {
        e.stopPropagation();
        moveItineraryItem(index, -1);
      });
      card.querySelector('.sort-btn.down').addEventListener('click', (e) => {
        e.stopPropagation();
        moveItineraryItem(index, 1);
      });
    }

    listContainer.appendChild(card);
  });
}

function moveItineraryItem(index, direction) {
  const trip = state.getActiveTrip();
  if (!trip) return;

  const list = [...(trip.itinerary[activeDay] || [])];
  const targetIndex = index + direction;
  
  if (targetIndex < 0 || targetIndex >= list.length) return;

  // Swap
  const temp = list[index];
  list[index] = list[targetIndex];
  list[targetIndex] = temp;

  // Recalculate schedule
  const updated = recalculateDaySchedule(list);
  state.updateItinerary(activeDay, updated);
  
  showToast('🔄 Route Reordered', 'Schedules updated to match new order.', 'success');
}

/* Play Screen & Mini-Game controls (Bingo, Wheel, Missions) */

function populatePlayUI(trip, user) {
  // Populate challenges selection in wheel dropdown
  const wheelSelect = document.getElementById('wheel-challenge-select');
  if (wheelSelect) {
    wheelSelect.innerHTML = '';
    trip.challenges.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.innerText = `${c.icon} ${c.title} (${c.points} XP)`;
      wheelSelect.appendChild(opt);
    });
  }

  // Draw wheel canvas representation
  spinWheel.draw(trip.members);

  // Render Bingo card
  renderBingoBoard('bingo-container', user.id, trip);

  // Renders Secret Missions
  populateMissionsUI(trip, user);

  // Renders active challenge card if assigned
  populateActiveChallengeCard(trip, user);
}

function bindGameEvents() {
  // Play view sub-panes toggler
  document.querySelectorAll('.quest-subnav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quest-subnav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('selected');
      btn.classList.add('active');

      const pane = btn.getAttribute('data-pane');
      document.querySelectorAll('.quest-pane-sub').forEach(p => p.style.display = 'none');
      document.getElementById(`pane-${pane}`).style.display = 'flex';
      
      // Canvas drawing needs layout updates
      if (pane === 'wheel') {
        const trip = state.getActiveTrip();
        if (trip) {
          setTimeout(() => spinWheel.draw(trip.members), 50);
        }
      }
    });
  });

  // Spin Wheel action
  document.getElementById('btn-spin-wheel').addEventListener('click', () => {
    const trip = state.getActiveTrip();
    if (!trip || trip.members.length === 0) return;

    const challengeId = document.getElementById('wheel-challenge-select').value;
    
    // Spin canvas animation
    spinWheel.spin(trip.members, challengeId, (selectedPlayer) => {
      state.spinWheelAssign(challengeId, selectedPlayer.id);
    });
  });
}

function populateActiveChallengeCard(trip, user) {
  const card = document.getElementById('active-challenge-card');
  if (!card) return;

  if (!trip.activeChallenge) {
    card.style.display = 'none';
    return;
  }

  const active = trip.activeChallenge;
  card.style.display = 'block';

  const isAssignedToMe = (active.assignedToId === user.id);
  const actionButtonHTML = isAssignedToMe && !active.completed
    ? `<button id="btn-complete-challenge" class="btn btn-primary" style="margin-top: 12px; font-size: 13px; padding: 10px;">Verify & Claim ${active.points} XP 🏆</button>`
    : active.completed 
      ? `<span style="color: var(--success); font-weight: bold; font-size: 13px; display: block; margin-top: 8px;">✓ Verified & Logged!</span>`
      : `<p style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">Waiting for ${active.assignedToName} to complete...</p>`;

  card.innerHTML = `
    <div class="card-title" style="color: var(--primary);">🎡 Active Wheel Challenge</div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <span style="font-size: 28px;">${active.icon}</span>
      <div>
        <h4 style="font-size: 15px; font-weight: 800;">${active.title}</h4>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">Assigned to: <b>${active.assignedToAvatar} ${active.assignedToName}</b></p>
      </div>
    </div>
    <p style="font-size: 12px; line-height: 1.4; margin-top: 8px; background: rgba(0,0,0,0.15); padding: 8px; border-radius: 8px; border: 1px solid #28284E;">
      ${active.title === 'The Ultimate Group Selfie' ? 'Take a group photo. Post in media gallery to verify!' : 'Perform the challenge task with local resources!'}
    </p>
    ${actionButtonHTML}
  `;

  // Attach completion click handler
  const completeBtn = card.querySelector('#btn-complete-challenge');
  if (completeBtn) {
    completeBtn.addEventListener('click', () => {
      // Simulate photo upload proof for selfie or similar
      const mockPics = [
        'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80', // group pose
        'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=400&q=80'  // delicious local food
      ];
      const randPic = mockPics[Math.floor(Math.random() * mockPics.length)];
      
      state.completeActiveChallenge(randPic);
      triggerConfetti();
      showToast('🏆 Challenge Logged', `XP credited to ${user.name}!`, 'success');
    });
  }
}

function populateMissionsUI(trip, user) {
  const container = document.getElementById('missions-container');
  if (!container) return;

  container.innerHTML = '';
  
  // Find missions assigned to current user
  const myMissions = trip.secretMissions.filter(m => m.assignedTo === user.id);
  
  if (myMissions.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 12px; margin-top: 16px;">No secret missions assigned. Click join or simulate member to refresh.</div>';
    return;
  }

  myMissions.forEach(mission => {
    const card = document.createElement('div');
    card.className = 'mission-card';
    card.innerHTML = `
      <div class="mission-header">
        <div class="mission-title-group">
          <span class="mission-icon">🤫</span>
          <span class="mission-title">Secret Mission</span>
        </div>
        <span class="mission-points">${mission.points} XP</span>
      </div>
      <p class="mission-desc">${mission.completed ? `<b>${mission.title}</b>: Completed!` : '🤫 Content hidden from others. Click complete to surprise group!'}</p>
      ${!mission.completed 
        ? `<button class="btn btn-secondary btn-claim-mission" data-id="${mission.id}" style="font-size: 12px; padding: 8px; width: auto; box-shadow: 0 2px 0 #1D4ED8;">Reveal & Complete 🔓</button>`
        : '<span style="color: var(--success); font-weight: bold; font-size: 12px;">✓ Completed & Shared!</span>'}
    `;

    const btn = card.querySelector('.btn-claim-mission');
    if (btn) {
      btn.addEventListener('click', () => {
        // Simple prompt simulator to confirm
        if (confirm(`Did you successfully complete: "${mission.title}"?\n\nTasks: ${mission.description}`)) {
          state.claimSecretMission(mission.id);
          triggerConfetti();
          showToast('🤫 Secret Mission', 'Surprise mission logged & points shared!', 'success');
        }
      });
    }

    container.appendChild(card);
  });
}

/* Chat view updates & Message feeding */

function populateChatUI(trip, user) {
  const scroller = document.getElementById('chat-scroller');
  if (!scroller) return;

  scroller.innerHTML = '';

  trip.chat.forEach(msg => {
    const bubble = document.createElement('div');
    const isMe = (msg.sender === user.name);
    bubble.className = `chat-bubble-container ${isMe ? 'mine' : ''}`;
    
    bubble.innerHTML = `
      <span class="chat-sender-avatar">${msg.avatar}</span>
      <div class="chat-bubble-content">
        <div class="chat-sender-name">${msg.sender}</div>
        <div class="chat-bubble-text">${msg.text}</div>
        <div class="chat-bubble-time">${msg.timestamp}</div>
      </div>
    `;

    scroller.appendChild(bubble);
  });

  // Auto scroll to bottom
  scroller.scrollTop = scroller.scrollHeight;
}

function bindChatEvents() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');

  const sendMessage = () => {
    const text = input.value.trim();
    if (!text) return;

    state.addChatMessage(state.user.name || 'Wanderer', state.user.avatar, text);
    input.value = '';
    
    // Auto simulate responses for single player experience!
    simulateChatReplies(text);
  };

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

function simulateChatReplies(userText) {
  const replies = [
    "Awesome! Let's do that next.",
    "Did anyone spin the wheel? I want a challenge!",
    "Wait, are we still at this spot? I am hungry, let's get food.",
    "Haha epic!",
    "Bingo board is getting competitive, watch out!"
  ];

  setTimeout(() => {
    const activeTrip = state.getActiveTrip();
    if (!activeTrip || activeTrip.members.length <= 1) return;

    // Pick a random participant that is not current user
    const rest = activeTrip.members.filter(m => m.id !== state.user.id);
    if (rest.length === 0) return;

    const chosen = rest[Math.floor(Math.random() * rest.length)];
    const randReply = replies[Math.floor(Math.random() * replies.length)];
    
    state.addChatMessage(chosen.name, chosen.avatar, randReply);
  }, 1500);
}

/* Memories & Photo grid uploading */

function populateMemoriesUI(trip, user) {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  grid.innerHTML = '';

  if (trip.gallery.length === 0) {
    grid.innerHTML = '<div style="grid-column: span 2; text-align: center; color: var(--text-muted); margin-top: 36px; font-size: 13px;">No memory photos uploaded yet. Click upload to start your travel log!</div>';
    return;
  }

  trip.gallery.forEach(photo => {
    const card = document.createElement('div');
    card.className = 'gallery-card animate__animated animate__fadeIn';
    card.innerHTML = `
      <div class="gallery-image-wrapper">
        <img src="${photo.url}" alt="trip-pic" />
        <span class="gallery-tag">${photo.category}</span>
      </div>
      <div class="gallery-info">
        <div class="gallery-caption">${photo.caption}</div>
        <div class="gallery-uploader">Uploaded by: <b>${photo.uploadedBy}</b></div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function bindGalleryEvents() {
  document.getElementById('btn-mock-photo-beach').addEventListener('click', () => {
    const url = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80';
    state.addGalleryPhoto(url, 'Chilling at the beach! 🌊', state.user.name, 'Beach');
    showToast('📸 Memory Logged', 'Photo added to Gallery!', 'success');
  });

  document.getElementById('btn-mock-photo-food').addEventListener('click', () => {
    const url = 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=400&q=80';
    state.addGalleryPhoto(url, 'Testing the local delicacy! 🍛🌶️', state.user.name, 'Food');
    showToast('📸 Memory Logged', 'Photo added to Gallery!', 'success');
  });
}

/* Standings Leaderboard & XP Leveling rendering */

function populateLeaderboardUI(trip, user) {
  // Update Team Scores
  const redScore = trip.teams?.Red?.score || 0;
  const blueScore = trip.teams?.Blue?.score || 0;
  document.getElementById('team-red-score').innerText = `${redScore} XP`;
  document.getElementById('team-blue-score').innerText = `${blueScore} XP`;

  // Sort players by XP descending
  const list = document.getElementById('leaderboard-list');
  if (!list) return;

  list.innerHTML = '';
  
  const sorted = [...trip.members].sort((a, b) => b.xp - a.xp);

  sorted.forEach((m, idx) => {
    const item = document.createElement('div');
    item.className = 'leaderboard-item';
    item.innerHTML = `
      <div class="leaderboard-rank rank-${idx + 1}">${idx + 1}</div>
      <span class="leaderboard-avatar">${m.avatar}</span>
      <div class="leaderboard-info">
        <div class="leaderboard-name">${m.name} ${m.id === user.id ? ' (You)' : ''}</div>
        <div class="leaderboard-level">Level ${m.level || 1} • <span style="color:${m.team === 'Red' ? '#EF4444' : '#3B82F6'}">${m.team} Team</span></div>
      </div>
      <div class="leaderboard-xp">${m.xp} XP</div>
    `;

    list.appendChild(item);
  });
}

/* Local Simulation controls ( showcase delay / join ) */

function bindSimulationEvents() {
  // Simulate 2 hour delay
  document.getElementById('btn-sim-delay').addEventListener('click', () => {
    const trip = state.getActiveTrip();
    if (!trip) return;

    // Grab first incomplete item from active day
    const dayPlaces = trip.itinerary[activeDay] || [];
    const activeIdx = dayPlaces.findIndex(p => !p.completed);
    if (activeIdx === -1) {
      showToast('⏰ Delay Sim', 'All events for today are finished!', 'info');
      return;
    }

    const currentItem = dayPlaces[activeIdx];
    const plannedStart = currentItem.startMinutes || 600;
    
    // Simulate current time being 2 hours later
    const actualTime = plannedStart + 120; // + 120 minutes

    // Setup modal text
    const timeStr = formatTime(actualTime);
    const plannedStr = currentItem.time;
    document.getElementById('delay-modal-body').innerHTML = `
      ⚠️ <b>Trip Delay Detected!</b><br>
      You are still at <b>${currentItem.name}</b> at <b>${timeStr}</b> (planned departure: ${plannedStr}).<br><br>
      Would you like the AI Planner to adjust upcoming schedules to accommodate this delay?
    `;

    document.getElementById('delay-overlay').classList.add('active');
  });

  // Simulate friend joining (Multiplayer Showcase)
  document.getElementById('btn-sim-member').addEventListener('click', () => {
    const trip = state.getActiveTrip();
    if (!trip) return;

    const names = ['AdventureAlice', 'GeekyGopi', 'BackpackerBen', 'ExplorerEmma', 'HikingHari'];
    const avatars = ['🐯', '🐸', '🐼', '🐙', '🦖'];
    const teams = ['Red', 'Blue'];

    const chosenName = names[Math.floor(Math.random() * names.length)];
    // Avoid duplicates
    if (trip.members.find(m => m.name === chosenName)) {
      showToast('👥 Simulator info', `${chosenName} has already joined the trip.`, 'info');
      return;
    }

    const chosenAvatar = avatars[Math.floor(Math.random() * avatars.length)];
    const chosenTeam = teams[Math.floor(Math.random() * teams.length)];

    // Inject directly into state via a mock join
    const randId = 'usr_' + Math.random().toString(36).substr(2, 9);
    
    trip.members.push({
      id: randId,
      name: chosenName,
      avatar: chosenAvatar,
      team: chosenTeam,
      xp: 150, // Starting XP
      level: 1
    });

    trip.bingo[randId] = Array(25).fill(false);
    
    // Trigger chat notifications
    state.addChatMessage('TripQuest Guide', '🎮', `🎉 ${chosenName} joined the quest using the Code: ${trip.code}!`);
    state.addXP(0); // force sync update
    
    showToast('👥 Member Joined', `${chosenName} joined your trip room!`, 'success');
  });
}

function formatTime(minutes) {
  const hrs = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const ampm = hrs >= 12 ? 'PM' : 'AM';
  const displayHrs = hrs % 12 || 12;
  const displayMins = mins < 10 ? '0' + mins : mins;
  return `${displayHrs}:${displayMins} ${ampm}`;
}

/* Modals overlays confirmations & Toaster alerts */

function bindOverlayEvents() {
  // Delay Cancel (Ignore)
  document.getElementById('btn-delay-cancel').addEventListener('click', () => {
    document.getElementById('delay-overlay').classList.remove('active');
  });

  // Delay Confirm (Recalculate)
  document.getElementById('btn-delay-confirm').addEventListener('click', () => {
    document.getElementById('delay-overlay').classList.remove('active');
    
    const trip = state.getActiveTrip();
    if (!trip) return;

    const dayPlaces = trip.itinerary[activeDay] || [];
    const activeIdx = dayPlaces.findIndex(p => !p.completed);
    if (activeIdx === -1) return;

    const currentItem = dayPlaces[activeIdx];
    const plannedStart = currentItem.startMinutes || 600;
    const actualTime = plannedStart + 120;

    const adjustment = suggestAdjustmentForDelay(dayPlaces, activeIdx, actualTime);
    if (adjustment.adjusted) {
      state.updateItinerary(activeDay, adjustment.schedule);
      showToast('⚡ Schedule Adjusted', 'Subsequent items pushed. Check for warnings!', 'success');
      triggerConfetti();
    }
  });
}

function bindSupabaseEvents() {
  const overlay = document.getElementById('supabase-overlay');
  const btnOpen = document.getElementById('header-supabase-btn');
  const btnClose = document.getElementById('btn-supabase-close');
  const btnSave = document.getElementById('btn-supabase-save');
  const btnCopySql = document.getElementById('btn-copy-sql');
  const urlInput = document.getElementById('supabase-url-input');
  const anonInput = document.getElementById('supabase-anon-input');
  const statusText = document.getElementById('supabase-status-text');

  // Load credentials on load
  const creds = supabaseConfig.getCredentials();
  urlInput.value = creds.url;
  anonInput.value = creds.key;

  const updateStatusText = () => {
    if (getSupabaseClient()) {
      statusText.innerHTML = 'Status: 🟢 Connected to Supabase Cloud';
      statusText.style.color = 'var(--success)';
      btnOpen.classList.add('supabase-connected-badge');
    } else {
      statusText.innerHTML = 'Status: 🟡 Local Storage Fallback Mode';
      statusText.style.color = 'var(--warning)';
      btnOpen.classList.remove('supabase-connected-badge');
    }
  };

  updateStatusText();

  // Open modal
  btnOpen.addEventListener('click', () => {
    overlay.classList.add('active');
  });

  // Close modal
  btnClose.addEventListener('click', () => {
    overlay.classList.remove('active');
  });

  // Save/Connect credentials
  btnSave.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const key = anonInput.value.trim();

    if (!url || !key) {
      // Clear credentials (Disconnect)
      disconnectSupabase();
      updateStatusText();
      showToast('⚡ Supabase Disconnected', 'Switched back to local storage fallback mode.', 'info');
      overlay.classList.remove('active');
      
      // Hot reload state client sync
      state.activeTripCode = localStorage.getItem(state.activeTripKey);
      state.notify();
      return;
    }

    btnSave.innerText = 'Connecting...';
    btnSave.disabled = true;

    const res = await testConnection(url, key);
    btnSave.innerText = 'Connect! 🔌';
    btnSave.disabled = false;

    if (res.success) {
      updateStatusText();
      showToast('⚡ Supabase Connected', 'Database connection successfully verified!', 'success');
      triggerConfetti();
      overlay.classList.remove('active');

      // Refresh connection and load existing room if active
      state.activeTripCode = localStorage.getItem(state.activeTripKey);
      state.initSupabaseConnection();
    } else {
      showToast('❌ Connection Failed', res.message, 'warning');
    }
  });

  // Copy SQL script to clipboard
  btnCopySql.addEventListener('click', () => {
    const sqlScript = `-- Create Trips Table
CREATE TABLE trips (
  code text PRIMARY KEY,
  name text NOT NULL,
  start_date date,
  days integer,
  style text,
  destinations jsonb,
  itinerary jsonb,
  active_challenge jsonb,
  teams jsonb
);

-- Create Players Table
CREATE TABLE players (
  id text PRIMARY KEY,
  trip_code text REFERENCES trips(code) ON DELETE CASCADE,
  name text NOT NULL,
  avatar text,
  team text,
  xp integer,
  level integer,
  bingo_card jsonb,
  secret_mission_id text,
  secret_mission_completed boolean
);

-- Create Chat Messages Table
CREATE TABLE chat_messages (
  id text PRIMARY KEY,
  trip_code text REFERENCES trips(code) ON DELETE CASCADE,
  sender text NOT NULL,
  avatar text,
  text text,
  created_at timestamp with time zone DEFAULT now()
);

-- Create Gallery Photos Table
CREATE TABLE gallery_photos (
  id text PRIMARY KEY,
  trip_code text REFERENCES trips(code) ON DELETE CASCADE,
  url text NOT NULL,
  caption text,
  uploaded_by text,
  category text,
  created_at timestamp with time zone DEFAULT now()
);

-- Enable Realtime for all tables
alter publication supabase_realtime add table trips;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table chat_messages;
alter publication supabase_realtime add table gallery_photos;`;

    navigator.clipboard.writeText(sqlScript).then(() => {
      showToast('📋 Copied SQL', 'SQL schema copied to clipboard! Paste in Supabase Editor.', 'success');
    }).catch(err => {
      console.error('Copy failed:', err);
    });
  });
}

// Spawns a floating notification
export function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;

  container.appendChild(toast);

  // Animate slide-out and remove
  setTimeout(() => {
    toast.style.transition = 'transform 0.3s, opacity 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 3500);
}
