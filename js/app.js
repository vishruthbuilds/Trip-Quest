// Core UI Orchestrator for TripQuest
import { state } from './state.js';
import { initializeSync } from './sync.js';
import { googleMapsLists } from './mockData.js';
import { kMeansClustering, optimizeRoute, recalculateDaySchedule, suggestAdjustmentForDelay } from './itinerary.js';
import { initMap, drawItineraryRoute, drawClustersOnMap, drawUserPins, panToCoords } from './maps.js';
import { renderBingoBoard, SpinWheel, triggerConfetti } from './game.js';
import { testConnection, supabaseConfig, disconnectSupabase, getSupabaseClient } from './supabase.js';

let spinWheel = null;
let activeDay = 1;

// Wizard State Variables
let wizardStep = 1;
let importedSights = [];
let hotelLocation = null;
let wizardMapInstance = null;
let wizardClusters = [];
let clusterDayAssignments = {};

// Profile photo (base64 data URL) selected during sign-up
let selectedProfilePhoto = null;

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Cross-Tab synchronization
  initializeSync();

  // Register Service Worker for PWA installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered successfully!', reg))
      .catch(err => console.warn('Service Worker registration failed:', err));
  }
  // Create SpinWheel Instance
  spinWheel = new SpinWheel('spinCanvas', 'btn-spin-wheel', 'spin-result-container');

  // Bind Initial UI Events
  bindOnboardingEvents();
  bindHostPlannerEvents();
  bindBottomNavEvents();
  bindHomeEvents();
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
    updateAuthUI();
    
    // If active trip exists, show Dashboard or route to it
    if (trip) {
      document.getElementById('room-code-tag').innerText = `CODE: ${trip.code}`;
      
      // If we are still on welcome/join screen, route to room
      const activeScreen = document.querySelector('.screen.active');
      if (activeScreen.id === 'screen-welcome' || activeScreen.id === 'screen-join') {
        if (trip.started) {
          showScreen('screen-room');
          showTab('home');
        } else {
          showScreen('screen-host');
          if (user.isHost) {
            goToWizardStep(wizardStep);
          } else {
            goToWizardStep(7); // Guests wait in lobby
          }
        }
      }

      // Hot reload active tabs
      reloadCurrentTabUI(trip, user);
    } else {
      // If trip deleted or left, send to welcome screen
      const activeScreen = document.querySelector('.screen.active');
      if (activeScreen && (activeScreen.id === 'screen-room' || activeScreen.id === 'screen-host')) {
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
    // If we have an active trip, populate values for wizard resuming
    if (activeTrip.destinations) importedSights = [...activeTrip.destinations];
    if (activeTrip.hotel) hotelLocation = activeTrip.hotel;
    if (activeTrip.clusters) clusterDayAssignments = { ...activeTrip.clusters };
    state.notify();
  } else {
    updateAuthUI();
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
  const sections = ['section-home', 'section-itinerary', 'section-play', 'section-chat', 'section-leaderboard'];
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
  const tabId = activeNav ? activeNav.getAttribute('data-tab') : 'home';

  switch (tabId) {
    case 'home':
      populateHomeUI(trip, user);
      break;
    case 'itinerary':
      populateItineraryUI(trip, user);
      break;
    case 'play':
      populatePlayUI(trip, user);
      break;
    case 'chat':
      populateChatUI(trip, user);
      break;
    case 'leaderboard':
      populateLeaderboardUI(trip, user);
      break;
  }
}

/* Onboarding Screen & Registration (Welcome View) */function updateAuthUI() {
  const authSection = document.getElementById('auth-section');
  const lobbySection = document.getElementById('lobby-section');
  
  if (state.user && state.user.email) {
    authSection.style.display = 'none';
    lobbySection.style.display = 'block';
    
    const photoEl = document.getElementById('lobby-user-photo');
    const avatarEl = document.getElementById('lobby-user-avatar');
    const photo = state.user.profilePhoto;

    if (photo) {
      photoEl.src = photo;
      photoEl.style.display = 'block';
      avatarEl.style.display = 'none';
    } else {
      avatarEl.innerText = state.user.avatar || '🦊';
      avatarEl.style.display = 'inline';
      photoEl.style.display = 'none';
    }

    document.getElementById('lobby-user-name').innerText = state.user.name || 'Wanderer';
    document.getElementById('lobby-user-details').innerText = `${state.user.team} Team • ${state.user.email}`;
  } else {
    authSection.style.display = 'block';
    lobbySection.style.display = 'none';
  }
}

function bindOnboardingEvents() {
  // Login / Signup tab switching
  const tabLogin = document.getElementById('auth-tab-login');
  const tabSignup = document.getElementById('auth-tab-signup');
  const signupFields = document.getElementById('signup-fields');
  let isSignup = false;

  if (tabLogin && tabSignup) {
    tabLogin.addEventListener('click', () => {
      tabLogin.className = 'btn btn-primary';
      tabSignup.className = 'btn btn-secondary';
      signupFields.style.display = 'none';
      isSignup = false;
    });

    tabSignup.addEventListener('click', () => {
      tabSignup.className = 'btn btn-primary';
      tabLogin.className = 'btn btn-secondary';
      signupFields.style.display = 'block';
      isSignup = true;
    });
  }

  // Avatar Selection
  const avatarOpts = document.querySelectorAll('.avatar-opt');
  avatarOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      avatarOpts.forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      // Selecting an emoji clears any uploaded photo
      selectedProfilePhoto = null;
      const previewImg = document.getElementById('profile-photo-img');
      const fallbackEmoji = document.getElementById('profile-photo-fallback-emoji');
      const removeBtn = document.getElementById('btn-remove-photo');
      if (previewImg) previewImg.style.display = 'none';
      if (fallbackEmoji) {
        fallbackEmoji.innerText = opt.getAttribute('data-avatar');
        fallbackEmoji.style.display = 'block';
      }
      if (removeBtn) removeBtn.style.display = 'none';
    });
  });

  // Profile Photo Upload from Device
  const photoUploadInput = document.getElementById('profile-photo-upload');
  const photoPreviewImg = document.getElementById('profile-photo-img');
  const photoFallbackEmoji = document.getElementById('profile-photo-fallback-emoji');
  const removePhotoBtn = document.getElementById('btn-remove-photo');

  if (photoUploadInput) {
    photoUploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        showToast('⚠️ Invalid File', 'Please select a valid image file (JPG, PNG, GIF, etc.)', 'warning');
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        showToast('⚠️ File Too Large', 'Please choose an image under 5 MB.', 'warning');
        return;
      }

      const reader = new FileReader();
      reader.onload = (evt) => {
        selectedProfilePhoto = evt.target.result; // base64 data URL
        if (photoPreviewImg) {
          photoPreviewImg.src = selectedProfilePhoto;
          photoPreviewImg.style.display = 'block';
        }
        if (photoFallbackEmoji) photoFallbackEmoji.style.display = 'none';
        if (removePhotoBtn) removePhotoBtn.style.display = 'inline-block';
        // Deselect emoji when a photo is chosen
        avatarOpts.forEach(o => o.classList.remove('selected'));
        showToast('📸 Photo Selected', 'Profile photo ready! Complete sign-up to save it.', 'success');
      };
      reader.readAsDataURL(file);
    });
  }

  if (removePhotoBtn) {
    removePhotoBtn.addEventListener('click', () => {
      selectedProfilePhoto = null;
      if (photoPreviewImg) photoPreviewImg.style.display = 'none';
      if (photoFallbackEmoji) {
        const selectedEmoji = document.querySelector('.avatar-opt.selected');
        photoFallbackEmoji.innerText = selectedEmoji ? selectedEmoji.getAttribute('data-avatar') : '🦊';
        photoFallbackEmoji.style.display = 'block';
      }
      if (photoUploadInput) photoUploadInput.value = '';
      removePhotoBtn.style.display = 'none';
      // Re-select first emoji
      if (avatarOpts[0]) avatarOpts[0].classList.add('selected');
    });
  }

  // Team Selection
  const teamBtns = document.querySelectorAll('.team-btn');
  teamBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      teamBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // Auth form submit
  document.getElementById('btn-auth-submit').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();

    if (!email || !password) {
      showToast('⚠️ Auth Required', 'Please enter email and password.', 'warning');
      return;
    }

    showToast('🔑 Authenticating', 'Logging in to room...', 'info');

    try {
      if (isSignup) {
        const nickname = document.getElementById('username-input').value.trim() || 'Wanderer';
        const avatar = document.querySelector('.avatar-opt.selected')?.getAttribute('data-avatar') || '🦊';
        const team = document.querySelector('.team-btn.selected')?.getAttribute('data-team') || 'Red';
        const profilePhoto = selectedProfilePhoto || null;
        
        await state.signUpUser(email, password, nickname, avatar, team, profilePhoto);
        showToast('🎉 Registered', 'Profile successfully registered!', 'success');
        // Clear photo selection after sign-up
        selectedProfilePhoto = null;
      } else {
        await state.signInUser(email, password);
        showToast('🎉 Logged In', 'Welcome back to TripQuest!', 'success');
      }
      triggerConfetti();
    } catch (err) {
      showToast('❌ Auth Error', err.message || 'Error authenticating user.', 'warning');
    }
  });

  // Sign out
  document.getElementById('btn-auth-signout').addEventListener('click', async () => {
    await state.signOutUser();
    showToast('🚪 Signed Out', 'Successfully logged out.', 'info');
  });

  // Host button click
  document.getElementById('btn-goto-host').addEventListener('click', () => {
    showScreen('screen-host');
    wizardStep = 1;
    goToWizardStep(1);
  });

  // Join screen route button
  document.getElementById('btn-goto-join').addEventListener('click', () => {
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

    showToast('🔑 Joining Room', 'Connecting...', 'info');

    state.joinTrip(code).then(res => {
      if (res.success) {
        showToast('🎉 Joined Room', `Connected to ${res.trip.name}!`, 'success');
        triggerConfetti();
        if (res.trip.started) {
          showScreen('screen-room');
          showTab('home');
        } else {
          showScreen('screen-host');
          goToWizardStep(7);
        }
      } else {
        showToast('❌ Not Found', res.message, 'warning');
      }
    }).catch(err => {
      showToast('❌ Error Joining', err.message || 'Error connecting to database.', 'warning');
    });
  });
}

function bindHostPlannerEvents() {
  // Prev button click
  document.getElementById('btn-wizard-prev').addEventListener('click', () => {
    if (wizardStep > 1) {
      goToWizardStep(wizardStep - 1);
    }
  });

  // Next button click
  document.getElementById('btn-wizard-next').addEventListener('click', () => {
    if (wizardStep < 8) {
      if (validateWizardStep(wizardStep)) {
        goToWizardStep(wizardStep + 1);
      }
    }
  });

  // Google Maps shared lists url import click
  document.getElementById('btn-import-url').addEventListener('click', async () => {
    const url = document.getElementById('import-url-input').value.trim();
    const cat = document.getElementById('import-category-select').value;
    if (!url) {
      showToast('⚠️ URL Required', 'Please paste a Google Maps shared list URL first!', 'warning');
      return;
    }

    document.getElementById('btn-import-url').innerText = '🔄 Scraping...';
    document.getElementById('btn-import-url').disabled = true;

    try {
      const proxyUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url);
      const res = await fetch(proxyUrl);
      const data = await res.json();
      const html = data.contents;
      
      const parsed = parseGoogleMapsSharedListHTML(html);
      
      if (parsed.length > 0) {
        parsed.forEach(p => p.category = cat);
        importedSights.push(...parsed);
        renderImportedSightsList();
        showToast('📍 Scraped Sights', `Successfully parsed ${parsed.length} places!`, 'success');
      } else {
        showToast('⚠️ Scraper Failed', 'CORS proxy failed to parse. Use presets or adder below.', 'warning');
      }
    } catch (err) {
      console.warn('Scraping error:', err);
      showToast('⚠️ Scraper Offline', 'Could not access URL. Add destinations manually below.', 'warning');
    } finally {
      document.getElementById('btn-import-url').innerText = 'Import ⚡';
      document.getElementById('btn-import-url').disabled = false;
      document.getElementById('import-url-input').value = '';
    }
  });

  // Presets load buttons
  document.getElementById('btn-preset-goa').addEventListener('click', () => {
    importedSights = JSON.parse(JSON.stringify(googleMapsLists['goa-adventure'].places));
    renderImportedSightsList();
    showToast('📍 Preset Loaded', 'Loaded Goa Adventure beaches!', 'success');
  });

  document.getElementById('btn-preset-pondy').addEventListener('click', () => {
    importedSights = JSON.parse(JSON.stringify(googleMapsLists['pondicherry-cafe'].places));
    renderImportedSightsList();
    showToast('📍 Preset Loaded', 'Loaded Pondicherry French cafes!', 'success');
  });

  document.getElementById('btn-preset-kyoto').addEventListener('click', () => {
    importedSights = JSON.parse(JSON.stringify(googleMapsLists['kyoto-historic'].places));
    renderImportedSightsList();
    showToast('📍 Preset Loaded', 'Loaded Kyoto Zen temples!', 'success');
  });

  // Manual Sight Adder Add button
  document.getElementById('btn-add-manual').addEventListener('click', () => {
    const name = document.getElementById('manual-sight-name').value.trim();
    const cat = document.getElementById('manual-sight-cat').value;
    if (!name) return;

    const baseLat = hotelLocation ? hotelLocation.lat : 15.4989;
    const baseLng = hotelLocation ? hotelLocation.lng : 73.8342;
    const offsetLat = (Math.random() - 0.5) * 0.05;
    const offsetLng = (Math.random() - 0.5) * 0.05;

    const place = {
      id: 'm-' + Math.random().toString(36).substr(2, 9),
      name: name,
      lat: baseLat + offsetLat,
      lng: baseLng + offsetLng,
      rating: (4.0 + Math.random() * 1.0).toFixed(1),
      photo: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80',
      hours: '24 Hours',
      category: cat,
      estTime: 90,
      description: 'Manually logged sightseeing spot.'
    };

    importedSights.push(place);
    document.getElementById('manual-sight-name').value = '';
    renderImportedSightsList();
    showToast('➕ Sight Added', `${name} added successfully!`, 'success');
  });

  // Generate clusters trigger button
  document.getElementById('btn-generate-clusters').addEventListener('click', () => {
    const activeTrip = state.getActiveTrip();
    if (!activeTrip || activeTrip.destinations.length === 0) return;

    const numClusters = Math.min(activeTrip.destinations.length, activeTrip.days);
    const clustered = kMeansClustering(activeTrip.destinations, numClusters);
    
    state.updateActiveTrip({ destinations: clustered });
    wizardClusters = clustered;
    
    renderClustersList();
    drawClustersOnMap(clustered, activeTrip.hotel);
    showToast('⚙️ Clusters Built', `Geographic K-Means divided sights into ${numClusters} clusters!`, 'success');
  });

  // Optimize routes trigger button
  document.getElementById('btn-optimize-routes').addEventListener('click', () => {
    const activeTrip = state.getActiveTrip();
    if (!activeTrip || activeTrip.destinations.length === 0) return;

    const itinerary = {};
    for (let d = 1; d <= activeTrip.days; d++) {
      itinerary[d] = [];
    }

    activeTrip.destinations.forEach(p => {
      const cid = p.clusterId !== undefined ? p.clusterId : 0;
      const assignedDay = clusterDayAssignments[cid] || 1;
      itinerary[assignedDay].push(p);
    });

    for (let d = 1; d <= activeTrip.days; d++) {
      const optimized = optimizeRoute(itinerary[d], activeTrip.hotel, true, activeTrip.style);
      itinerary[d] = optimized;
    }

    state.updateActiveTrip({ itinerary });
    renderOptimizationSummaryList();

    if (itinerary[1] && itinerary[1].length > 0) {
      drawItineraryRoute(itinerary[1]);
    }
    showToast('⚡ TSP Route Optimized', 'Route optimization completed relative to Hotel!', 'success');
  });

  // Copy Lobby room code trigger button
  document.getElementById('btn-copy-lobby-code').addEventListener('click', () => {
    const code = document.getElementById('wizard-room-code').innerText;
    navigator.clipboard.writeText(code).then(() => {
      showToast('📋 Copied Code', 'Room Code copied to clipboard!', 'success');
    });
  });

  // Start trip finish button
  document.getElementById('btn-wizard-finish').addEventListener('click', () => {
    state.updateActiveTrip({ started: true });
    showScreen('screen-room');
    showTab('home');
    triggerConfetti();
    showToast('🚀 Quest Started!', 'Multiplayer travel game started!', 'success');
  });
}

function parseGoogleMapsSharedListHTML(html) {
  const places = [];
  const placeUrlRegex = /\/maps\/place\/([^/]+)\/@(-?\d+\.\d+),(-?\d+\.\d+)/g;
  let match;
  const seenNames = new Set();
  
  while ((match = placeUrlRegex.exec(html)) !== null) {
    const rawName = decodeURIComponent(match[1].replace(/\+/g, ' '));
    const lat = parseFloat(match[2]);
    const lng = parseFloat(match[3]);
    
    if (lat && lng && !seenNames.has(rawName)) {
      seenNames.add(rawName);
      places.push({
        id: 'gm-' + Math.random().toString(36).substr(2, 9),
        name: rawName,
        lat,
        lng,
        rating: (4.0 + Math.random() * 1.0).toFixed(1),
        photo: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80',
        hours: '24 Hours',
        category: 'Attractions',
        estTime: 90,
        description: 'Imported sight.'
      });
    }
  }

  if (places.length === 0) {
    const arrayRegex = /\["([^"]+)",(-?\d+\.\d+),(-?\d+\.\d+)\]/g;
    while ((match = arrayRegex.exec(html)) !== null) {
      const name = match[1];
      const lat = parseFloat(match[2]);
      const lng = parseFloat(match[3]);
      if (lat && lng && !seenNames.has(name) && name.length < 50 && !name.includes('{')) {
        seenNames.add(name);
        places.push({
          id: 'gm-' + Math.random().toString(36).substr(2, 9),
          name,
          lat,
          lng,
          rating: (4.0 + Math.random() * 1.0).toFixed(1),
          photo: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80',
          hours: '24 Hours',
          category: 'Attractions',
          estTime: 90,
          description: 'Imported sight.'
        });
      }
    }
  }
  return places;
}

function goToWizardStep(step) {
  wizardStep = step;
  const stepLabels = [
    'Create Trip Room',
    'Add Base Hotel',
    'Import Shared Lists',
    'Generate Clusters',
    'Assign Clusters to Days',
    'Optimize Routes',
    'Invite Friends Lobby',
    'Start Quest Adventure'
  ];
  
  document.getElementById('wizard-title').innerText = stepLabels[step - 1];
  document.getElementById('wizard-step-label').innerText = `Step ${step} of 8: ${stepLabels[step - 1]}`;
  document.getElementById('wizard-progress-fill').style.width = (step / 8) * 100 + '%';
  
  for (let s = 1; s <= 8; s++) {
    const panel = document.getElementById(`wizard-step-${s}`);
    if (panel) {
      panel.style.display = (s === step) ? 'block' : 'none';
    }
  }
  
  const nextBtn = document.getElementById('btn-wizard-next');
  const prevBtn = document.getElementById('btn-wizard-prev');
  
  prevBtn.style.visibility = (step === 1) ? 'hidden' : 'visible';
  nextBtn.style.display = (step === 8) ? 'none' : 'block';
  
  const activeTrip = state.getActiveTrip();
  const isHost = state.user.isHost;
  
  if (activeTrip && !isHost && step !== 7) {
    wizardStep = 7;
    document.getElementById('wizard-title').innerText = 'Multiplayer Lobby';
    document.getElementById('wizard-step-label').innerText = 'Waiting for Host...';
    prevBtn.style.visibility = 'hidden';
    nextBtn.style.display = 'none';
    for (let s = 1; s <= 8; s++) {
      const panel = document.getElementById(`wizard-step-${s}`);
      if (panel) panel.style.display = (s === 7) ? 'block' : 'none';
    }
  }

  const mapDiv = document.getElementById('wizard-map');
  if (step === 2 || step === 4 || step === 6) {
    mapDiv.style.display = 'block';
    if (!wizardMapInstance) {
      wizardMapInstance = initMap('wizard-map');
      wizardMapInstance.on('click', (e) => {
        if (wizardStep === 2) {
          document.getElementById('hotel-lat-input').value = e.latlng.lat.toFixed(6);
          document.getElementById('hotel-lng-input').value = e.latlng.lng.toFixed(6);
          hotelLocation = {
            name: document.getElementById('hotel-name-input').value.trim() || 'Taj Hotel',
            lat: e.latlng.lat,
            lng: e.latlng.lng
          };
          drawClustersOnMap([], hotelLocation);
        }
      });
    }
    
    setTimeout(() => {
      wizardMapInstance.invalidateSize();
      if (step === 2) {
        const lat = parseFloat(document.getElementById('hotel-lat-input').value) || 15.4989;
        const lng = parseFloat(document.getElementById('hotel-lng-input').value) || 73.8342;
        drawClustersOnMap([], { name: document.getElementById('hotel-name-input').value, lat, lng });
      } else if (step === 4) {
        drawClustersOnMap(activeTrip.destinations, activeTrip.hotel);
      } else if (step === 6) {
        const dayPlaces = activeTrip.itinerary[1] || [];
        drawItineraryRoute(dayPlaces);
      }
    }, 100);
  } else {
    mapDiv.style.display = 'none';
  }

  if (step === 3) {
    renderImportedSightsList();
  } else if (step === 4) {
    renderClustersList();
  } else if (step === 5) {
    renderDayAssignmentList();
  } else if (step === 6) {
    renderOptimizationSummaryList();
  } else if (step === 7) {
    renderLobbyPlayers();
  }
}

function validateWizardStep(step) {
  const activeTrip = state.getActiveTrip();
  if (step === 1) {
    const name = document.getElementById('trip-name-input').value.trim();
    const days = parseInt(document.getElementById('trip-days-input').value);
    if (!name) {
      showToast('⚠️ Input Required', 'Please enter a trip name!', 'warning');
      return false;
    }
    if (!days || days < 1 || days > 7) {
      showToast('⚠️ Input Required', 'Duration must be between 1 and 7 days!', 'warning');
      return false;
    }
    
    if (!activeTrip) {
      state.createTrip(name, document.getElementById('trip-date-input').value, days);
      state.updateActiveTrip({ style: document.getElementById('travel-style-select').value });
    } else {
      state.updateActiveTrip({
        name,
        days,
        startDate: document.getElementById('trip-date-input').value,
        style: document.getElementById('travel-style-select').value
      });
    }
    return true;
  }
  
  if (step === 2) {
    const hotelName = document.getElementById('hotel-name-input').value.trim();
    const lat = parseFloat(document.getElementById('hotel-lat-input').value);
    const lng = parseFloat(document.getElementById('hotel-lng-input').value);
    if (!hotelName || isNaN(lat) || isNaN(lng)) {
      showToast('⚠️ Hotel Required', 'Please enter hotel name and coordinates!', 'warning');
      return false;
    }
    hotelLocation = { name: hotelName, lat, lng };
    state.updateActiveTrip({ hotel: hotelLocation });
    return true;
  }

  if (step === 3) {
    if (importedSights.length === 0) {
      showToast('⚠️ Destinations Required', 'Please import at least one sight first!', 'warning');
      return false;
    }
    state.updateActiveTrip({ destinations: importedSights });
    return true;
  }

  if (step === 4) {
    if (wizardClusters.length === 0) {
      showToast('⚠️ Clusters Required', 'Please generate clusters first!', 'warning');
      return false;
    }
    return true;
  }

  if (step === 5) {
    const trip = state.getActiveTrip();
    const numClusters = Math.min(trip.destinations.length, trip.days);
    for (let c = 0; c < numClusters; c++) {
      if (clusterDayAssignments[c] === undefined) {
        showToast('⚠️ Assignment Required', `Please assign Group ${String.fromCharCode(65 + c)} to a day!`, 'warning');
        return false;
      }
    }
    state.updateActiveTrip({ clusters: clusterDayAssignments });
    return true;
  }

  if (step === 6) {
    if (!activeTrip || !activeTrip.itinerary || Object.keys(activeTrip.itinerary).length === 0) {
      showToast('⚠️ Optimization Required', 'Please run route optimization first!', 'warning');
      return false;
    }
    return true;
  }

  return true;
}

function renderImportedSightsList() {
  const container = document.getElementById('imported-sights-list');
  if (!container) return;
  if (importedSights.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 6px;">No places imported yet.</div>';
    return;
  }
  
  container.innerHTML = '';
  importedSights.forEach((s, idx) => {
    const item = document.createElement('div');
    item.style = 'display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; margin-bottom: 4px; background: rgba(0,0,0,0.2); border-radius: 8px;';
    item.innerHTML = `
      <span style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px;">📍 ${s.name} (${s.category})</span>
      <button class="btn-delete-imported" data-idx="${idx}" style="background: none; border: none; color: #EF4444; font-weight: bold; cursor: pointer; padding: 2px 6px;">❌</button>
    `;
    item.querySelector('.btn-delete-imported').addEventListener('click', (e) => {
      const i = parseInt(e.target.getAttribute('data-idx'));
      importedSights.splice(i, 1);
      renderImportedSightsList();
    });
    container.appendChild(item);
  });
}

function renderClustersList() {
  const container = document.getElementById('clusters-display-list');
  if (!container) return;
  
  container.innerHTML = '';
  const activeTrip = state.getActiveTrip();
  if (!activeTrip) return;
  
  const clusterMap = {};
  activeTrip.destinations.forEach(d => {
    const cid = d.clusterId !== undefined ? d.clusterId : 0;
    if (!clusterMap[cid]) clusterMap[cid] = [];
    clusterMap[cid].push(d);
  });

  const clusterColors = ['#FF6B4A', '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#14B8A6'];

  Object.keys(clusterMap).sort().forEach(cid => {
    const sights = clusterMap[cid];
    const color = clusterColors[parseInt(cid) % clusterColors.length];
    const card = document.createElement('div');
    card.style = `border-left: 5px solid ${color}; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; margin-bottom: 6px;`;
    card.innerHTML = `
      <div style="font-weight: 800; color: ${color}; font-size: 13px;">Group ${String.fromCharCode(65 + parseInt(cid))} (${sights.length} Sights)</div>
      <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; word-break: break-all;">
        ${sights.map(s => s.name).join(', ')}
      </div>
    `;
    container.appendChild(card);
  });
}

function renderDayAssignmentList() {
  const container = document.getElementById('day-assignment-container');
  if (!container) return;
  
  container.innerHTML = '';
  const activeTrip = state.getActiveTrip();
  if (!activeTrip) return;

  const clustersSet = new Set();
  activeTrip.destinations.forEach(d => {
    if (d.clusterId !== undefined) clustersSet.add(d.clusterId);
  });
  
  const sortedClusters = Array.from(clustersSet).sort();
  const clusterColors = ['#FF6B4A', '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#14B8A6'];

  sortedClusters.forEach(cid => {
    const clusterColor = clusterColors[cid % clusterColors.length];
    const clusterSights = activeTrip.destinations.filter(d => d.clusterId === cid);
    const assignedDay = clusterDayAssignments[cid] || (cid + 1);
    clusterDayAssignments[cid] = assignedDay;

    const card = document.createElement('div');
    card.style = `background: var(--bg-card-hover); padding: 12px; border-radius: 12px; border: 1.5px solid #28284E;`;
    
    let selectOptions = '';
    for (let d = 1; d <= activeTrip.days; d++) {
      selectOptions += `<option value="${d}" ${assignedDay === d ? 'selected' : ''}>Day ${d}</option>`;
    }

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span style="font-weight: 800; color: ${clusterColor}; font-size: 14px;">Group ${String.fromCharCode(65 + cid)}</span>
        <select class="form-select select-cluster-day" data-cid="${cid}" style="width: auto; padding: 4px 8px; font-size: 12px; border-radius: 8px; background: #28284E; color: #FFF; border: none;">
          ${selectOptions}
        </select>
      </div>
      <p style="font-size: 11px; color: var(--text-muted); line-height: 1.4;">${clusterSights.map(s => s.name).join(', ')}</p>
    `;

    card.querySelector('.select-cluster-day').addEventListener('change', (e) => {
      const cidInt = parseInt(e.target.getAttribute('data-cid'));
      const dayVal = parseInt(e.target.value);
      clusterDayAssignments[cidInt] = dayVal;
    });

    container.appendChild(card);
  });
}

function renderOptimizationSummaryList() {
  const container = document.getElementById('optimization-summary-list');
  if (!container) return;
  
  container.innerHTML = '';
  const activeTrip = state.getActiveTrip();
  if (!activeTrip || !activeTrip.itinerary || Object.keys(activeTrip.itinerary).length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 12px; font-size: 12px;">No optimized routes found. Click the button above to calculate routes!</div>';
    return;
  }

  // Draw tabs to switch preview day
  const tabSelector = document.createElement('div');
  tabSelector.style = 'display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto;';
  
  Object.keys(activeTrip.itinerary).forEach((dayNum, idx) => {
    const tabBtn = document.createElement('button');
    tabBtn.className = `btn ${idx === 0 ? 'btn-primary' : 'btn-secondary'}`;
    tabBtn.style = 'padding: 6px 12px; font-size: 11px; width: auto; box-shadow: none;';
    tabBtn.innerText = `Day ${dayNum}`;
    tabBtn.addEventListener('click', () => {
      tabSelector.querySelectorAll('button').forEach(b => {
        b.className = 'btn btn-secondary';
      });
      tabBtn.className = 'btn btn-primary';
      drawItineraryRoute(activeTrip.itinerary[dayNum]);
    });
    tabSelector.appendChild(tabBtn);
  });
  container.appendChild(tabSelector);

  Object.entries(activeTrip.itinerary).forEach(([dayNum, sights]) => {
    const card = document.createElement('div');
    card.style = 'background: rgba(0,0,0,0.15); border: 1.5px solid #28284E; border-radius: 10px; padding: 10px; margin-bottom: 8px;';
    
    const count = sights.filter(s => s.id !== 'hotel-start' && s.id !== 'hotel-end').length;
    let totalDist = 0;
    sights.forEach(s => {
      if (s.distanceFromPrev) totalDist += s.distanceFromPrev;
    });

    const sequence = sights.map(s => {
      if (s.id === 'hotel-start') return '🏨 Start';
      if (s.id === 'hotel-end') return '🏨 Return';
      return s.name;
    }).join(' ➔ ');

    card.innerHTML = `
      <div style="font-weight: bold; font-size: 13px; display: flex; justify-content: space-between;">
        <span>Day ${dayNum} Route Map</span>
        <span style="color: var(--primary); font-size: 11px;">${count} sights • ${totalDist.toFixed(1)} km</span>
      </div>
      <p style="font-size: 11px; color: var(--text-muted); margin-top: 4px; line-height: 1.4; word-break: break-all;">
        ${sequence}
      </p>
    `;
    container.appendChild(card);
  });
}

function renderLobbyPlayers() {
  const container = document.getElementById('lobby-players-list');
  if (!container) return;
  
  container.innerHTML = '';
  const activeTrip = state.getActiveTrip();
  if (!activeTrip) return;

  document.getElementById('wizard-room-code').innerText = activeTrip.code;

  activeTrip.members.forEach(p => {
    const item = document.createElement('div');
    item.style = 'display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(0,0,0,0.2); border-radius: 10px; margin-bottom: 4px;';
    item.innerHTML = `
      <span style="font-size: 20px;">${p.avatar}</span>
      <div style="flex: 1;">
        <div style="font-weight: bold; font-size: 13px; color: #FFF;">${p.name} ${p.id === state.user.id ? '(You)' : ''}</div>
        <div style="font-size: 10px; color: var(--text-muted);">${p.team} Team</div>
      </div>
      <span style="font-size: 10px; background: var(--success); color: #FFF; padding: 2px 6px; border-radius: 10px; font-weight: bold;">Lobby</span>
    `;
    container.appendChild(item);
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

function bindHomeEvents() {
  document.getElementById('btn-quick-chat').addEventListener('click', () => showTab('chat'));
  document.getElementById('btn-quick-spin').addEventListener('click', () => {
    showTab('play');
    const subnavBtns = document.querySelectorAll('.quest-subnav-btn');
    if (subnavBtns[1]) subnavBtns[1].click();
  });
  document.getElementById('btn-quick-bingo').addEventListener('click', () => {
    showTab('play');
    const subnavBtns = document.querySelectorAll('.quest-subnav-btn');
    if (subnavBtns[0]) subnavBtns[0].click();
  });
  document.getElementById('btn-quick-media').addEventListener('click', () => {
    const sunsetUrl = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80';
    state.addGalleryPhoto(sunsetUrl, 'Chilling at the beach! 🌊', state.user.name, 'Beach');
    showToast('📸 Sunset Uploaded', 'Sunset photo added to Group Memories!', 'success');
    triggerConfetti();
  });
}

function populateHomeUI(trip, user) {
  document.getElementById('home-trip-name').innerText = trip.name;
  document.getElementById('home-trip-dates').innerText = `Starts: ${trip.startDate} • ${trip.days} Days`;
  
  // Update scores
  const redScore = trip.teams?.Red?.score || 0;
  const blueScore = trip.teams?.Blue?.score || 0;
  document.getElementById('home-red-score').innerText = `${redScore} XP`;
  document.getElementById('home-blue-score').innerText = `${blueScore} XP`;
  
  // Progress bar
  const totalScore = redScore + blueScore;
  const fillWidth = totalScore > 0 ? (redScore / totalScore) * 100 : 50;
  document.getElementById('home-xp-fill').style.width = fillWidth + '%';
  
  const leadingText = redScore > blueScore ? 'Team Red leads the quest!' : redScore < blueScore ? 'Team Blue leads the quest!' : 'Teams are tied!';
  document.getElementById('home-xp-leading').innerText = leadingText;

  // Challenge Card
  const challengeCard = document.getElementById('home-challenge-content');
  if (trip.activeChallenge) {
    const act = trip.activeChallenge;
    challengeCard.innerHTML = `
      <span style="font-size: 32px;">${act.icon}</span>
      <div>
        <h4 style="font-size: 14px; font-weight: bold; color: #FFF;">${act.title}</h4>
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Assigned to: <b>${act.assignedToName}</b> (+${act.points} XP)</p>
      </div>
    `;
  } else {
    challengeCard.innerHTML = `
      <span style="font-size: 32px;">🎡</span>
      <div>
        <h4 style="font-size: 14px; font-weight: bold; color: #FFF;">No Active Challenge</h4>
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Head to the Spin Wheel tab to assign a challenge!</p>
      </div>
    `;
  }

  // Next Destination
  const dayPlaces = trip.itinerary[activeDay] || [];
  const nextPlace = dayPlaces.find(p => !p.completed && p.id !== 'hotel-start' && p.id !== 'hotel-end');

  if (nextPlace) {
    document.getElementById('home-next-name').innerText = nextPlace.name;
    document.getElementById('home-next-time').innerText = `Scheduled: ${nextPlace.time} • ${nextPlace.duration}m (${nextPlace.category})`;
    
    const navBtn = document.getElementById('btn-home-navigate');
    navBtn.style.display = 'block';
    
    // Replace old listeners
    const newNavBtn = navBtn.cloneNode(true);
    navBtn.parentNode.replaceChild(newNavBtn, navBtn);
    newNavBtn.addEventListener('click', () => {
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(nextPlace.name)}`, '_blank');
      showToast('🗺️ Directions Open', `Navigating to ${nextPlace.name}...`, 'success');
    });
  } else {
    document.getElementById('home-next-name').innerText = 'All Done today! 🎉';
    document.getElementById('home-next-time').innerText = 'No incomplete sights remaining.';
    document.getElementById('btn-home-navigate').style.display = 'none';
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
