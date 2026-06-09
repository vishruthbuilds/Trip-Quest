// ═══════════════════════════════════════════════════════════
// TripQuest · App Orchestrator
// ═══════════════════════════════════════════════════════════

import {
  isConnected, testConnection, getCredentials, saveCredentials,
  loadActiveTrip, saveActiveTrip, loadDestinations, saveDestinations
} from './supabase.js';

// ── Real Takeout Data Store (populated after user uploads JSON) ────────────
// Maps list name → array of place objects { name, lat, lng, category, maps_url }
const TakeoutLists = {};

// ── In-Memory Application State ──────────────────────────
const State = {
  trip: { id: 'local_trip_id', name: 'My Goa Itinerary' },
  days: ['Day 1', 'Day 2', 'Day 3'], // Day-wise separation
  activeDayIndex: 0,                 // Currently selected day (0 = Day 1)
  importedPlaces: [], // List of places available to add
  destinations: [],   // Active itinerary list across all days
  map: null,
  markersLayer: null,
  routeLine: null,
  activeStopIndex: null, // Relative to activeDayIndex
  isTransit: false,
  transitFrom: null,
  transitTo: null,
  
  // Real-time alarm tracking
  alarmDismissedStopId: null,
  alarmSnoozedUntil: null,
  lastNotifiedStopId: null
};

// Category colors for Leaflet markers
const CategoryColors = {
  Attraction: '#F59E0B', // Yellow
  Cafe: '#FF6B4A',       // Coral/Orange
  Restaurant: '#EC4899', // Pink
  Hotel: '#3B82F6',      // Blue
  Activity: '#10B981',   // Green
  Custom: '#8B5CF6'      // Purple
};

const CategoryEmojis = {
  Attraction: '🎯',
  Cafe: '☕',
  Restaurant: '🍜',
  Hotel: '🏨',
  Activity: '🏄',
  Custom: '📍'
};

// ── Boot Application ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Request Notification permission
  if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    Notification.requestPermission();
  }

  // 1. Initial State Load
  await loadState();

  // 2. Bind UI Event Listeners
  bindEvents();

  // 3. Initialize Leaflet Map with Google roadmap tiles
  initGoogleLeafletMap();

  // 4. Render Initial Views
  renderAll();

  // 5. Start Clock Ticker
  startClock();
});

// ── Load & Save State ─────────────────────────────────────
async function loadState() {
  // Load saved days structure
  try {
    const rawDays = localStorage.getItem('tq_itinerary_days');
    State.days = rawDays ? JSON.parse(rawDays) : ['Day 1', 'Day 2', 'Day 3'];
  } catch (e) {
    State.days = ['Day 1', 'Day 2', 'Day 3'];
  }

  // Restore previously imported places from localStorage if any
  try {
    const rawPlaces = localStorage.getItem('tq_imported_places');
    if (rawPlaces) State.importedPlaces = JSON.parse(rawPlaces);
    const rawTakeout = localStorage.getItem('tq_takeout_lists');
    if (rawTakeout) {
      const parsed = JSON.parse(rawTakeout);
      Object.assign(TakeoutLists, parsed);
      // Rebuild list selector dropdown
      buildListSelectorDropdown();
    }
  } catch (e) { /* ignore */ }

  // Load trip and destinations from Supabase or localStorage
  const activeTrip = await loadActiveTrip();
  if (activeTrip) {
    State.trip = activeTrip;
  } else {
    // Save a default local trip if none exists
    await saveActiveTrip(State.trip);
  }

  document.getElementById('trip-name').value = State.trip.name || '';

  const dests = await loadDestinations(State.trip.id);
  State.destinations = dests || [];
  
  // Backward compatibility: ensure all destinations have day_index and duration
  State.destinations.forEach((d, idx) => {
    if (!d.id) d.id = 'dest_' + idx + '_' + Date.now();
    if (d.day_index === undefined) d.day_index = 0;
    if (!d.duration) d.duration = 90;
    if (!d.category) d.category = 'Attraction';
  });
}

async function saveTripDetails() {
  const tripNameInput = document.getElementById('trip-name').value.trim();
  State.trip.name = tripNameInput || 'My Itinerary';
  await saveActiveTrip(State.trip);
  showToast('Trip details saved!', 'success');
}

async function saveItineraryState() {
  // Recalculate timings sequentially starting from the first stop of the active day
  recalculateScheduleTimings();

  // Save to Database / LocalStorage
  const saved = await saveDestinations(State.trip.id, State.destinations);
  if (saved) {
    // Keep local IDs mapped to any generated UUIDs
    State.destinations = saved.map(d => ({
      ...d,
      id: d.id || 'dest_' + Math.random().toString(36).substr(2, 9)
    }));
  }
  
  renderTimeline();
  drawRouteOnMap();
}

// ── Timing Helpers ────────────────────────────────────────
function formatMinutes(minutes) {
  const hrs = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const ampm = hrs >= 12 ? 'PM' : 'AM';
  const displayHrs = hrs % 12 || 12;
  const displayMins = mins < 10 ? '0' + mins : mins;
  return `${displayHrs}:${displayMins} ${ampm}`;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 540; // Default 9:00 AM
  const match = timeStr.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) {
    const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
      return parseInt(match24[1]) * 60 + parseInt(match24[2]);
    }
    return 540;
  }
  let hrs = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hrs < 12) hrs += 12;
  if (ampm === 'AM' && hrs === 12) hrs = 0;
  return hrs * 60 + mins;
}

function getCurrentMinutesFromMidnight() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** 
 * Automatically sequences stops for the CURRENT ACTIVE DAY sequentially.
 * Calculates transit times between consecutive stops.
 */
function recalculateScheduleTimings() {
  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);
  if (activeDests.length === 0) return;

  // Set the start time of the first stop to whatever is currently entered
  let currentTime = parseTimeToMinutes(activeDests[0].time);
  activeDests[0].time = formatMinutes(currentTime);

  for (let i = 0; i < activeDests.length; i++) {
    const stop = activeDests[i];
    
    stop.time = formatMinutes(currentTime);
    const duration = parseInt(stop.duration) || 60;
    
    if (i < activeDests.length - 1) {
      const nextStop = activeDests[i + 1];
      
      // Use cached road transit duration if available, else fall back to Haversine estimate
      let transitMins = 15;
      if (stop.roadTransitDuration) {
        transitMins = Math.max(3, Math.round(stop.roadTransitDuration));
      } else {
        const dist = haversineKm(stop.lat, stop.lng, nextStop.lat, nextStop.lng);
        const transit = estimateTransit(dist);
        transitMins = transit.mins;
      }
      
      currentTime += duration + transitMins;
    }
  }
}

// ── Geodesic Distance Fallback Helpers ─────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0;
  const R = 6371; // Earth radius
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

function estimateTransit(km) {
  if (km < 1.2) {
    const mins = Math.max(3, Math.round((km / 5) * 60));
    return { mode: 'Walk 🚶', mins, desc: `~${mins} min walk` };
  }
  const mins = Math.max(5, Math.round((km / 30) * 60));
  return { mode: 'Drive 🚗', mins, desc: `~${mins} min drive` };
}

// ── UI Rendering ──────────────────────────────────────────
function renderAll() {
  renderSavedPlacesPool();
  renderDayTabs();
  renderTimeline();
}

function renderDayTabs() {
  const container = document.getElementById('day-tabs-container');
  if (!container) return;

  container.innerHTML = '';
  State.days.forEach((dayName, idx) => {
    const tab = document.createElement('button');
    tab.className = `day-tab ${idx === State.activeDayIndex ? 'active' : ''}`;
    tab.textContent = dayName;
    
    tab.addEventListener('click', () => {
      State.activeDayIndex = idx;
      renderDayTabs();
      renderTimeline();
      drawRouteOnMap();
    });
    
    // Double click to delete day
    tab.addEventListener('dblclick', () => {
      if (State.days.length <= 1) {
        showToast('You must have at least one day in your trip.', 'warning');
        return;
      }
      if (confirm(`Delete ${dayName} and all its stops?`)) {
        // Remove day name
        State.days.splice(idx, 1);
        
        // Remove all destinations for this day
        State.destinations = State.destinations.filter(d => d.day_index !== idx);
        
        // Shift higher day indices down
        State.destinations.forEach(d => {
          if (d.day_index > idx) d.day_index -= 1;
        });

        // Set active day to previous or first
        State.activeDayIndex = Math.max(0, idx - 1);
        localStorage.setItem('tq_itinerary_days', JSON.stringify(State.days));
        saveItineraryState();
        renderDayTabs();
      }
    });

    container.appendChild(tab);
  });
}

function renderSavedPlacesPool() {
  const container = document.getElementById('saved-places-pool');
  const countEl = document.getElementById('saved-count');
  if (!container) return;

  countEl.textContent = State.importedPlaces.length;

  if (State.importedPlaces.length === 0) {
    container.innerHTML = '<div class="pool-empty-hint">Import Google Maps places to start building your itinerary.</div>';
    return;
  }

  container.innerHTML = '';
  State.importedPlaces.forEach((place, idx) => {
    const card = document.createElement('div');
    card.className = 'saved-place-card';
    
    const emoji = CategoryEmojis[place.category] || '📍';
    const coordsStr = place.lat && place.lng ? `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}` : 'No coordinates';

    card.innerHTML = `
      <div class="place-info-block">
        <div class="place-title-row">
          <span class="category-badge" title="${place.category}">${emoji}</span>
          <span class="place-name" title="${place.name}">${place.name}</span>
        </div>
        <span class="place-coords">${coordsStr}</span>
      </div>
      <div class="place-actions">
        <button class="btn-add-pool" data-idx="${idx}" title="Add to Itinerary">+</button>
        <button class="btn-delete-pool" data-idx="${idx}" title="Delete from pool">✕</button>
      </div>
    `;

    // Map flyTo on hover
    card.addEventListener('mouseenter', () => {
      if (place.lat && place.lng && State.map) {
        State.map.flyTo([place.lat, place.lng], 14);
      }
    });

    container.appendChild(card);
  });

  // Bind pool buttons
  container.querySelectorAll('.btn-add-pool').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      addPlaceToItinerary(idx);
    });
  });

  container.querySelectorAll('.btn-delete-pool').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      deleteFromPool(idx);
    });
  });
}

function renderTimeline() {
  const container = document.getElementById('timeline-list');
  if (!container) return;

  // Filter stops by the currently active day
  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);

  if (activeDests.length === 0) {
    container.innerHTML = '<div class="timeline-empty-hint">Add places from your Saved Places pool to this day.</div>';
    return;
  }

  container.innerHTML = '';
  activeDests.forEach((stop, idx) => {
    // Find index of this stop in the global array
    const globalIdx = State.destinations.findIndex(d => d.id === stop.id);

    const wrapper = document.createElement('div');
    wrapper.className = 'timeline-stop-wrapper';
    wrapper.dataset.index = globalIdx; // Drag-drop references the global index
    
    // Add active class if this stop is the currently active one
    if (idx === State.activeStopIndex && !State.isTransit) {
      wrapper.classList.add('active');
    }

    const emoji = CategoryEmojis[stop.category] || '📍';

    wrapper.innerHTML = `
      <div class="timeline-node-dot"></div>
      <div class="timeline-stop-card" draggable="true">
        <span class="drag-handle">⠿</span>
        <div class="stop-main-info">
          <div class="stop-title-row">
            <span class="category-badge" title="${stop.category}">${emoji}</span>
            <span class="stop-title" title="${stop.name}">${stop.name}</span>
          </div>
          <div class="stop-time-settings">
            <div class="time-input-wrap">
              <span>Start</span>
              <input type="text" class="input-time-schedule" data-idx="${globalIdx}" value="${stop.time}" ${idx > 0 ? 'disabled' : ''} placeholder="e.g. 10:00 AM">
            </div>
            <div class="time-input-wrap">
              <span>Duration</span>
              <input type="number" class="input-duration" data-idx="${globalIdx}" min="5" max="480" value="${stop.duration}">
              <span>min</span>
            </div>
          </div>
        </div>
        <button class="btn-delete-stop" data-idx="${globalIdx}" title="Remove stop">✕</button>
      </div>
    `;

    // Add flyTo on click
    wrapper.querySelector('.stop-title').addEventListener('click', () => {
      if (stop.lat && stop.lng && State.map) {
        State.map.flyTo([stop.lat, stop.lng], 15);
      }
    });

    container.appendChild(wrapper);

    // If not the last stop, append transit info card
    if (idx < activeDests.length - 1) {
      const nextStop = activeDests[idx + 1];
      
      // Load OSRM-based road transit values if loaded, else estimate
      const dist = stop.roadTransitDistance !== undefined ? stop.roadTransitDistance : haversineKm(stop.lat, stop.lng, nextStop.lat, nextStop.lng);
      const isWalking = dist < 1.2;
      const transitMins = stop.roadTransitDuration !== undefined ? Math.round(stop.roadTransitDuration) : (isWalking ? Math.round((dist / 5) * 60) : Math.round((dist / 30) * 60));
      
      const modeText = isWalking ? 'Walk 🚶' : 'Drive 🚗';
      const durationText = `~${transitMins} min ${isWalking ? 'walk' : 'drive'}`;

      const transitNode = document.createElement('div');
      transitNode.className = 'timeline-transit-node';
      transitNode.innerHTML = `
        <span class="transit-icon">${modeText.split(' ')[0]}</span>
        <span class="transit-details">${modeText.split(' ')[1]} ${formatDistance(dist)} (${durationText})</span>
      `;
      container.appendChild(transitNode);
    }
  });

  // Bind inputs and delete buttons
  container.querySelectorAll('.btn-delete-stop').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      removePlaceFromItinerary(idx);
    });
  });

  container.querySelectorAll('.input-time-schedule').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const val = e.target.value.trim();
      State.destinations[idx].time = val;
      saveItineraryState();
    });
  });

  container.querySelectorAll('.input-duration').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const val = parseInt(e.target.value) || 60;
      State.destinations[idx].duration = val;
      saveItineraryState();
    });
  });

  // Drag and Drop ordering
  bindDragAndDrop(container);
}

// ── Drag & Drop Implementation ────────────────────────────
let dragSourceIndex = null;

function bindDragAndDrop(container) {
  const cards = container.querySelectorAll('.timeline-stop-wrapper');
  
  cards.forEach(wrapper => {
    const stopCard = wrapper.querySelector('.timeline-stop-card');

    stopCard.addEventListener('dragstart', (e) => {
      dragSourceIndex = parseInt(wrapper.dataset.index);
      e.dataTransfer.effectAllowed = 'move';
      wrapper.style.opacity = '0.5';
    });

    wrapper.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    wrapper.addEventListener('dragenter', () => {
      wrapper.style.borderLeft = '2px solid var(--primary)';
    });

    wrapper.style.transition = 'border 0.1s ease';

    wrapper.addEventListener('dragleave', () => {
      wrapper.style.borderLeft = '';
    });

    stopCard.addEventListener('dragend', () => {
      wrapper.style.opacity = '1';
      cards.forEach(c => c.style.borderLeft = '');
    });

    wrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      wrapper.style.borderLeft = '';
      const targetIndex = parseInt(wrapper.dataset.index);
      
      if (dragSourceIndex !== null && dragSourceIndex !== targetIndex) {
        // Swap or move elements in the main destinations array
        const movedItem = State.destinations.splice(dragSourceIndex, 1)[0];
        State.destinations.splice(targetIndex, 0, movedItem);
        saveItineraryState();
      }
      dragSourceIndex = null;
    });
  });
}

// ── State Mutators ────────────────────────────────────────
function addPlaceToItinerary(poolIdx) {
  const place = State.importedPlaces[poolIdx];
  if (!place) return;

  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);

  // Generate a unique ID
  const newStop = {
    id: 'dest_' + Math.random().toString(36).substr(2, 9),
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    maps_url: place.maps_url || '',
    category: place.category || 'Attraction',
    time: activeDests.length === 0 ? '09:00 AM' : '', // Sequences auto calculated
    duration: 90,
    day_index: State.activeDayIndex // Set stop day to currently active day
  };

  State.destinations.push(newStop);
  saveItineraryState();
  showToast(`📍 Added "${place.name}" to Day ${State.activeDayIndex + 1}!`, 'success');
}

function removePlaceFromItinerary(globalIdx) {
  const removed = State.destinations.splice(globalIdx, 1)[0];
  saveItineraryState();
  if (removed) {
    showToast(`✕ Removed "${removed.name}" from itinerary.`, 'info');
  }
}

function deleteFromPool(idx) {
  const removed = State.importedPlaces.splice(idx, 1)[0];
  localStorage.setItem('tq_imported_places', JSON.stringify(State.importedPlaces));
  renderSavedPlacesPool();
  if (removed) {
    showToast(`Deleted "${removed.name}" from saved list.`, 'info');
  }
}

// ── Leaflet Map Controls (Google roadmap tiles) ───────────
function initGoogleLeafletMap() {
  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);
  const center = activeDests.length > 0 
    ? [activeDests[0].lat, activeDests[0].lng] 
    : [15.5523, 73.7771]; // Default to Goa

  State.map = L.map('map-container', {
    zoomControl: false,
    scrollWheelZoom: true
  }).setView(center, 12);

  // standard Google Maps roadmap tiles layer
  L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps',
    maxZoom: 20
  }).addTo(State.map);

  L.control.zoom({
    position: 'bottomright'
  }).addTo(State.map);

  State.markersLayer = L.layerGroup().addTo(State.map);

  drawRouteOnMap();
}

/**
 * Plots day-specific markers, connects them by requesting exact roadway coordinates from OSRM,
 * and caches computed durations.
 */
async function drawRouteOnMap() {
  if (!State.map || !State.markersLayer) return;

  State.markersLayer.clearLayers();
  if (State.routeLine) {
    State.map.removeLayer(State.routeLine);
    State.routeLine = null;
  }

  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);
  if (activeDests.length === 0) return;

  const latlngs = [];
  activeDests.forEach((stop, idx) => {
    const coords = [stop.lat, stop.lng];
    latlngs.push(coords);

    const color = CategoryColors[stop.category] || '#FF6B4A';
    
    // Check if this stop is the currently active one
    const isActive = (idx === State.activeStopIndex && !State.isTransit);

    const customIcon = L.divIcon({
      html: `
        <div class="custom-map-pin ${isActive ? 'active' : ''}" style="background-color: ${color}; border: 3px solid #FFF;">
          <span class="pin-number">${idx + 1}</span>
        </div>
      `,
      className: 'custom-leaflet-icon',
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    });

    const marker = L.marker(coords, { icon: customIcon });
    
    const emoji = CategoryEmojis[stop.category] || '📍';
    const popupContent = `
      <div class="map-popup-card">
        <h4>${emoji} ${stop.name}</h4>
        <p>Day: <b>${State.activeDayIndex + 1}</b></p>
        <p>Arrival: <b>${stop.time}</b> (${stop.duration} mins)</p>
        ${stop.maps_url ? `<p style="margin-top:5px;"><a href="${stop.maps_url}" target="_blank" style="color:var(--primary); text-decoration:none; font-weight:600;">View on Google Maps ↗</a></p>` : ''}
      </div>
    `;

    marker.bindPopup(popupContent);
    State.markersLayer.addLayer(marker);
  });

  // Calculate actual ROADWAYS shortest routes using OSRM API
  if (latlngs.length > 1) {
    const coordsQuery = latlngs.map(c => `${c[1]},${c[0]}`).join(';');
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsQuery}?overview=full&geometries=geojson`;

    try {
      const res = await fetch(osrmUrl);
      if (!res.ok) throw new Error('OSRM routing request failed');
      const data = await res.json();

      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        
        // Draw the exact roadway geometry on the map
        State.routeLine = L.geoJSON(route.geometry, {
          color: '#FF6B4A',
          weight: 5,
          opacity: 0.85
        }).addTo(State.map);

        // Update timeline transit times using the actual road distance/durations
        let timingsChanged = false;
        if (route.legs && route.legs.length === activeDests.length - 1) {
          route.legs.forEach((leg, i) => {
            const stop = activeDests[i];
            const roadDist = leg.distance / 1000;      // km
            const roadMins = leg.duration / 60;        // minutes

            if (stop.roadTransitDistance !== roadDist || stop.roadTransitDuration !== roadMins) {
              stop.roadTransitDistance = roadDist;
              stop.roadTransitDuration = roadMins;
              timingsChanged = true;
            }
          });
        }

        if (timingsChanged) {
          // Re-sequence arrival times sequentially and save
          recalculateScheduleTimings();
          renderTimeline();
        }

        // Fit boundaries to show full road layout
        State.map.fitBounds(State.routeLine.getBounds(), { padding: [50, 50] });
      }
    } catch (err) {
      console.warn('[OSRM Routing] Falling back to straight-line route representation:', err);
      // Fallback: draw straight dashed line connecting stops
      State.routeLine = L.polyline(latlngs, {
        color: '#FF6B4A',
        weight: 4,
        opacity: 0.8,
        dashArray: '8, 8'
      }).addTo(State.map);
      
      State.map.fitBounds(State.routeLine.getBounds(), { padding: [50, 50] });
    }
  } else if (latlngs.length === 1) {
    State.map.setView(latlngs[0], 14);
  }
}

// ── Google Maps / OSM Nominatim Place Importer ────────────
async function importFromInput() {
  const importInput = document.getElementById('import-input');
  const inputStr = importInput.value.trim();
  if (!inputStr) {
    showToast('Please enter Google Maps links or place names.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-import');
  const progress = document.getElementById('import-progress');
  const progressText = document.getElementById('import-progress-text');
  const defaultCategory = document.getElementById('import-category').value;

  btn.disabled = true;
  progress.style.display = 'flex';
  progressText.textContent = 'Analyzing input...';

  const lines = inputStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('http://') || line.startsWith('https://')) {
      progressText.textContent = `Scraping URL (${i + 1}/${lines.length})...`;
      try {
        const place = await scrapeGoogleMapsUrl(line);
        if (place && place.name) {
          State.importedPlaces.push({
            name: place.name,
            lat: place.lat,
            lng: place.lng,
            category: defaultCategory,
            maps_url: line,
            description: ''
          });
          successCount++;
        } else {
          if (place && place.name && !place.lat) {
            const geocoded = await geocodeTextName(place.name);
            if (geocoded) {
              State.importedPlaces.push({
                name: place.name,
                lat: geocoded.lat,
                lng: geocoded.lng,
                category: defaultCategory,
                maps_url: line,
                description: ''
              });
              successCount++;
              continue;
            }
          }
          failCount++;
        }
      } catch (e) {
        console.warn('URL scraping failed, trying text fallback...', e);
        const queryName = extractNameFromMapsUrl(line);
        if (queryName) {
          const geocoded = await geocodeTextName(queryName);
          if (geocoded) {
            State.importedPlaces.push({
              name: queryName,
              lat: geocoded.lat,
              lng: geocoded.lng,
              category: defaultCategory,
              maps_url: line,
              description: ''
            });
            successCount++;
            continue;
          }
        }
        failCount++;
      }
    } else {
      progressText.textContent = `Searching "${line}" (${i + 1}/${lines.length})...`;
      try {
        const geocoded = await geocodeTextName(line);
        if (geocoded) {
          State.importedPlaces.push({
            name: geocoded.name || line,
            lat: geocoded.lat,
            lng: geocoded.lng,
            category: defaultCategory,
            maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(line)}`,
            description: ''
          });
          successCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        failCount++;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  localStorage.setItem('tq_imported_places', JSON.stringify(State.importedPlaces));
  renderSavedPlacesPool();
  importInput.value = '';

  btn.disabled = false;
  progress.style.display = 'none';

  if (successCount > 0) {
    showToast(`Successfully imported ${successCount} places!`, 'success');
  }
  if (failCount > 0) {
    showToast(`Failed to resolve ${failCount} items. Try typing exact names.`, 'warning', 4000);
  }
}

function extractNameFromMapsUrl(url) {
  try {
    const decoded = decodeURIComponent(url);
    const placeMatch = decoded.match(/maps\/place\/([^/@]+)/);
    if (placeMatch) return placeMatch[1].replace(/\+/g, ' ');
    const queryMatch = decoded.match(/query=([^&]+)/) || decoded.match(/q=([^&]+)/);
    if (queryMatch) return queryMatch[1].replace(/\+/g, ' ');
  } catch (e) {}
  return null;
}

async function scrapeGoogleMapsUrl(url) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('CORS Proxy failed');

  const json = await res.json();
  const html = json.contents || '';
  const finalUrl = json.status?.url || url;

  let name = '';
  const titleMatch = html.match(/<title[^>]*>([^<|·]+)/i);
  if (titleMatch) {
    name = titleMatch[1].replace(/\s*[-|·]\s*Google Maps.*$/i, '').trim();
  }
  if (!name || name.toLowerCase().includes('google maps')) {
    const extracted = extractNameFromMapsUrl(finalUrl);
    if (extracted) name = extracted;
  }

  let lat = null, lng = null;
  const coordsMatch = (finalUrl + html).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (coordsMatch) {
    lat = parseFloat(coordsMatch[1]);
    lng = parseFloat(coordsMatch[2]);
  } else {
    const altCoordsMatch = html.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
    if (altCoordsMatch) {
      lat = parseFloat(altCoordsMatch[1]);
      lng = parseFloat(altCoordsMatch[2]);
    }
  }

  return { name: name || 'Google Maps Place', lat, lng };
}

async function geocodeTextName(name) {
  const cleanQuery = name.trim();
  const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanQuery)}&limit=1`;
  
  const res = await fetch(searchUrl, {
    headers: {
      'Accept-Language': 'en',
      'User-Agent': 'TripQuest Itinerary Planner'
    }
  });

  if (!res.ok) return null;
  const json = await res.json();
  if (json && json.length > 0) {
    const result = json[0];
    return {
      name: result.name || result.display_name.split(',')[0],
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon)
    };
  }
  return null;
}

// ── Web Audio Synth Beep Alarm ────────────────────────────
function playAlarmChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    // Pulse A5 and C#6 note sequence
    const notes = [880, 1109]; 
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.25);
      
      gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.25);
      gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + idx * 0.25 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.25 + 0.4);
      
      osc.start(ctx.currentTime + idx * 0.25);
      osc.stop(ctx.currentTime + idx * 0.25 + 0.45);
    });
  } catch (e) {
    console.warn('Audio synthesis failed:', e);
  }
}

// ── Real-Time Tracking Core & 10-Minute Warnings ──────────
function startClock() {
  setInterval(() => {
    const activeMinutes = getCurrentMinutesFromMidnight();

    // Update clock
    const clockEl = document.getElementById('clock-display');
    if (clockEl) clockEl.textContent = formatMinutes(activeMinutes);

    // Evaluate stop statuses
    evaluateCurrentStopStatus(activeMinutes);
    
    // Check 10-minute warning schedules
    checkDepartureAlertSchedules(activeMinutes);
  }, 1000);
}

function evaluateCurrentStopStatus(activeTime) {
  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);
  if (activeDests.length === 0) {
    updateActiveStopUI(null, false);
    return;
  }

  let matchedIdx = null;
  let isTransit = false;
  let transitFrom = null;
  let transitTo = null;

  const firstStopStart = parseTimeToMinutes(activeDests[0].time);
  
  if (activeTime < firstStopStart) {
    updateActiveStopUI({
      type: 'upcoming',
      nextStop: activeDests[0]
    });
    return;
  }

  for (let i = 0; i < activeDests.length; i++) {
    const stop = activeDests[i];
    const start = parseTimeToMinutes(stop.time);
    const end = start + (parseInt(stop.duration) || 60);

    if (activeTime >= start && activeTime <= end) {
      matchedIdx = i;
      break;
    }

    if (i < activeDests.length - 1) {
      const nextStop = activeDests[i + 1];
      const nextStart = parseTimeToMinutes(nextStop.time);
      
      if (activeTime > end && activeTime < nextStart) {
        isTransit = true;
        transitFrom = stop;
        transitTo = nextStop;
        break;
      }
    }
  }

  if (matchedIdx !== null) {
    const activeStop = activeDests[matchedIdx];
    const endMins = parseTimeToMinutes(activeStop.time) + (parseInt(activeStop.duration) || 60);
    const remaining = endMins - activeTime;

    updateActiveStopUI({
      type: 'active',
      stop: activeStop,
      index: matchedIdx,
      remainingText: `ends in ${remaining} mins`
    });
  } else if (isTransit) {
    const nextStart = parseTimeToMinutes(transitTo.time);
    const remaining = nextStart - activeTime;
    const dist = transitFrom.roadTransitDistance !== undefined ? transitFrom.roadTransitDistance : haversineKm(transitFrom.lat, transitFrom.lng, transitTo.lat, transitTo.lng);
    const travelTime = transitFrom.roadTransitDuration !== undefined ? Math.round(transitFrom.roadTransitDuration) : (dist < 1.2 ? Math.round((dist / 5) * 60) : Math.round((dist / 30) * 60));

    updateActiveStopUI({
      type: 'transit',
      from: transitFrom,
      to: transitTo,
      remainingText: `Arriving in ~${remaining} min (${formatDistance(dist)} via roadways)`
    });
  } else {
    updateActiveStopUI({
      type: 'completed'
    });
  }
}

/** 
 * Scans active day timeline and fires warning alerts 10 minutes before travel starts 
 */
function checkDepartureAlertSchedules(activeTime) {
  const activeDests = State.destinations.filter(d => d.day_index === State.activeDayIndex);
  if (activeDests.length < 2) return;

  // Check if alarm currently snoozed
  if (State.alarmSnoozedUntil && Date.now() < State.alarmSnoozedUntil) return;

  for (let i = 1; i < activeDests.length; i++) {
    const nextStop = activeDests[i];
    const prevStop = activeDests[i - 1];

    // Read distance and travel duration between stops
    const dist = prevStop.roadTransitDistance !== undefined ? prevStop.roadTransitDistance : haversineKm(prevStop.lat, prevStop.lng, nextStop.lat, nextStop.lng);
    const transitDuration = prevStop.roadTransitDuration !== undefined ? Math.round(prevStop.roadTransitDuration) : (dist < 1.2 ? Math.round((dist / 5) * 60) : Math.round((dist / 30) * 60));

    const nextStartMin = parseTimeToMinutes(nextStop.time);
    const requiredDepartureTime = nextStartMin - transitDuration;
    
    // We alarm 10 minutes before the departure time
    const alarmTime = requiredDepartureTime - 10;

    // Trigger condition
    if (activeTime >= alarmTime && activeTime < requiredDepartureTime) {
      // Prevent double alarm triggers for the same next stop
      if (State.alarmDismissedStopId === nextStop.id || State.lastNotifiedStopId === nextStop.id) {
        continue;
      }

      triggerDepartureAlarm(nextStop, dist, transitDuration);
      break;
    }
  }
}

function triggerDepartureAlarm(nextStop, distance, durationMins) {
  State.lastNotifiedStopId = nextStop.id;

  // 1. Play synthesize chime
  playAlarmChime();

  // 2. Display Overlay Alert
  const msgEl = document.getElementById('alarm-message');
  msgEl.innerHTML = `
    You need to leave for <b>${nextStop.name}</b> in 10 minutes!
    <br>Distance: <b>${formatDistance(distance)}</b> | Drive time: <b>${durationMins} mins</b>.
  `;
  document.getElementById('alarm-overlay').classList.add('active');

  // 3. Push native OS warning
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('TripQuest Departure Warning', {
      body: `Leave for ${nextStop.name} in 10 mins! (Distance: ${formatDistance(distance)}, travel: ${durationMins} mins)`,
      icon: './icon.svg'
    });
  }
}

function updateActiveStopUI(status, forceMapDraw = true) {
  const card = document.getElementById('active-stop-card');
  const placeTitle = document.getElementById('active-place-name');
  const timeDesc = document.getElementById('active-place-time');

  if (!status) {
    placeTitle.textContent = 'No stops planned';
    timeDesc.textContent = 'Add places to the timeline';
    State.activeStopIndex = null;
    State.isTransit = false;
    return;
  }

  let changed = false;

  if (status.type === 'upcoming') {
    card.querySelector('.status-label').textContent = 'UPCOMING FIRST STOP';
    placeTitle.textContent = status.nextStop.name;
    timeDesc.textContent = `Starts at ${status.nextStop.time}`;
    
    if (State.activeStopIndex !== null || State.isTransit !== false) {
      State.activeStopIndex = null;
      State.isTransit = false;
      changed = true;
    }
  } 
  else if (status.type === 'active') {
    card.querySelector('.status-label').textContent = '🟢 CURRENT STOP';
    placeTitle.textContent = status.stop.name;
    const stopDuration = parseInt(status.stop.duration) || 60;
    timeDesc.textContent = `${status.stop.time} - ${formatMinutes(parseTimeToMinutes(status.stop.time) + stopDuration)} (${status.remainingText})`;
    
    if (State.activeStopIndex !== status.index || State.isTransit !== false) {
      State.activeStopIndex = status.index;
      State.isTransit = false;
      changed = true;
    }
  } 
  else if (status.type === 'transit') {
    card.querySelector('.status-label').textContent = '🚗 TRANSIT BETWEEN STOPS';
    placeTitle.textContent = `Heading to ${status.to.name}`;
    timeDesc.textContent = status.remainingText;
    
    if (State.activeStopIndex !== null || State.isTransit !== true) {
      State.activeStopIndex = null;
      State.isTransit = true;
      changed = true;
    }
  } 
  else if (status.type === 'completed') {
    card.querySelector('.status-label').textContent = '🏁 TRIP COMPLETED';
    placeTitle.textContent = 'All stops visited!';
    timeDesc.textContent = 'Itinerary completed for today.';
    
    if (State.activeStopIndex !== null || State.isTransit !== false) {
      State.activeStopIndex = null;
      State.isTransit = false;
      changed = true;
    }
  }

  if (changed || forceMapDraw) {
    renderTimeline();
    drawRouteOnMap();

    // Map auto pans to current stop or bounds
    if (status.type === 'active' && State.map) {
      State.map.setView([status.stop.lat, status.stop.lng], 14);
    } else if (status.type === 'transit' && State.map) {
      const bounds = L.latLngBounds(
        [status.from.lat, status.from.lng],
        [status.to.lat, status.to.lng]
      );
      State.map.fitBounds(bounds, { padding: [100, 100] });
    }
  }
}

// ── Google Takeout JSON Parser ────────────────────────────
/**
 * Parses a Google Takeout Maps JSON file (GeoJSON FeatureCollection format)
 * and populates TakeoutLists.
 * 
 * Supports:
 *  - Individual list files: Saved Places.json, Want to go.json, etc.
 *  - Multi-list Takeout zip containing many JSON files (user uploads one at a time)
 */
function parseTakeoutJSON(jsonText, fileName) {
  const statusEl = document.getElementById('takeout-status');

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('Invalid JSON file. Make sure to upload a .json file from Google Takeout.');
  }

  // Detect format: GeoJSON FeatureCollection
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('File is not a Google Takeout Maps export. Expected a GeoJSON FeatureCollection.');
  }

  // Derive the list name from the file name (strip .json) or from data.title
  const listName = (data.title && data.title.trim()) 
    || fileName.replace(/\.json$/i, '').trim() 
    || 'Imported List';

  // Guess category from list name
  const categoryGuess = guessCategoryFromListName(listName);

  const places = [];
  data.features.forEach(feature => {
    try {
      const props = feature.properties || {};
      const geo = feature.geometry;

      // Name: prefer Business Name > Title > Location name
      const name = props.Location?.['Business Name'] 
        || props.Title 
        || props.name 
        || 'Unknown Place';

      // Coordinates: prefer Geo Coordinates > geometry coordinates
      let lat = null, lng = null;
      if (props.Location?.['Geo Coordinates']) {
        lat = parseFloat(props.Location['Geo Coordinates']['Latitude']);
        lng = parseFloat(props.Location['Geo Coordinates']['Longitude']);
      } else if (geo?.type === 'Point' && Array.isArray(geo.coordinates)) {
        // GeoJSON convention: [longitude, latitude]
        lng = geo.coordinates[0];
        lat = geo.coordinates[1];
      }

      if (!name || !lat || !lng || isNaN(lat) || isNaN(lng)) return;

      const mapsUrl = props['Google Maps URL'] || props.url || '';
      const address = props.Location?.Address || '';

      places.push({ name, lat, lng, category: categoryGuess, maps_url: mapsUrl, address });
    } catch (e) {
      // Skip malformed features
    }
  });

  if (places.length === 0) {
    throw new Error(`No valid places with coordinates found in "${listName}". Make sure this list has saved places with location data.`);
  }

  // Store in TakeoutLists
  TakeoutLists[listName] = places;

  // Persist to localStorage so it survives page refreshes
  localStorage.setItem('tq_takeout_lists', JSON.stringify(TakeoutLists));

  // Rebuild dropdown and auto-select the just-uploaded list
  buildListSelectorDropdown(listName);

  // Load the imported list into the pool immediately
  State.importedPlaces = [...places];
  localStorage.setItem('tq_imported_places', JSON.stringify(State.importedPlaces));
  renderSavedPlacesPool();

  // Show success
  statusEl.textContent = `✅ Loaded "${listName}" — ${places.length} places imported!`;
  statusEl.className = 'takeout-status success';

  showToast(`📥 "${listName}" imported with ${places.length} places!`, 'success', 4000);
}

function guessCategoryFromListName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('cafe') || lower.includes('coffee')) return 'Cafe';
  if (lower.includes('meal') || lower.includes('food') || lower.includes('restaurant') || lower.includes('eat')) return 'Restaurant';
  if (lower.includes('stay') || lower.includes('hotel') || lower.includes('resort')) return 'Hotel';
  if (lower.includes('party') || lower.includes('event') || lower.includes('activity')) return 'Activity';
  return 'Attraction';
}

/**
 * Rebuilds the list selector <select> with all currently loaded TakeoutLists.
 * Optionally pre-selects the given listName.
 */
function buildListSelectorDropdown(selectListName = null) {
  const select = document.getElementById('gmaps-list-select');
  const card = document.getElementById('list-selector-card');
  if (!select) return;

  const listNames = Object.keys(TakeoutLists);
  if (listNames.length === 0) {
    if (card) card.style.display = 'none';
    return;
  }

  select.innerHTML = '';
  listNames.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${getCategoryEmoji(TakeoutLists[name][0]?.category)} ${name} (${TakeoutLists[name].length})`;
    select.appendChild(option);
  });

  if (selectListName && listNames.includes(selectListName)) {
    select.value = selectListName;
  }

  if (card) card.style.display = 'block';
}

function getCategoryEmoji(category) {
  const map = { Attraction: '🎯', Cafe: '☕', Restaurant: '🍜', Hotel: '🏨', Activity: '🏄', Custom: '📍' };
  return map[category] || '📍';
}

// ── Event Bindings ────────────────────────────────────────
function bindEvents() {
  document.getElementById('btn-import').addEventListener('click', importFromInput);
  document.getElementById('trip-name').addEventListener('change', saveTripDetails);

  // Saved List selector change (after Takeout loaded)
  document.getElementById('gmaps-list-select').addEventListener('change', (e) => {
    const listKey = e.target.value;
    const places = TakeoutLists[listKey] || [];
    State.importedPlaces = [...places];
    localStorage.setItem('tq_imported_places', JSON.stringify(State.importedPlaces));
    renderSavedPlacesPool();
    const label = e.target.options[e.target.selectedIndex]?.text || listKey;
    showToast(`Loaded "${label}" (${places.length} places)`, 'success');
  });

  // Google Takeout JSON file upload
  document.getElementById('takeout-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('takeout-status');
    statusEl.textContent = 'Reading file...';
    statusEl.className = 'takeout-status';

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        parseTakeoutJSON(event.target.result, file.name);
      } catch (err) {
        statusEl.textContent = '❌ Failed to read file: ' + err.message;
        statusEl.className = 'takeout-status error';
      }
    };
    reader.readAsText(file);
  });

  // Add new day
  document.getElementById('btn-add-day').addEventListener('click', () => {
    const newDayNum = State.days.length + 1;
    State.days.push(`Day ${newDayNum}`);
    
    localStorage.setItem('tq_itinerary_days', JSON.stringify(State.days));
    State.activeDayIndex = newDayNum - 1;
    
    saveItineraryState();
    renderDayTabs();
    showToast(`Added Day ${newDayNum}!`, 'success');
  });

  // Alarm modal buttons
  document.getElementById('btn-alarm-snooze').addEventListener('click', () => {
    State.alarmSnoozedUntil = Date.now() + 5 * 60 * 1000; // Snooze 5 minutes
    document.getElementById('alarm-overlay').classList.remove('active');
    showToast('Alert snoozed for 5 minutes.', 'info');
  });

  document.getElementById('btn-alarm-dismiss').addEventListener('click', () => {
    State.alarmDismissedStopId = State.lastNotifiedStopId;
    document.getElementById('alarm-overlay').classList.remove('active');
    showToast('Alert dismissed.', 'info');
  });

  // Database Connection setup modal
  const setupBtn = document.getElementById('btn-open-sb-setup');
  const modal = document.getElementById('modal-supabase');
  const cancelBtn = document.getElementById('btn-sb-cancel');
  const connectBtn = document.getElementById('btn-sb-connect');

  setupBtn.addEventListener('click', () => {
    modal.classList.add('active');
    const creds = getCredentials();
    document.getElementById('sb-url').value = creds.url;
    document.getElementById('sb-key').value = creds.key;
    document.getElementById('sb-connection-status').textContent = isConnected() ? '✅ Connected' : '❌ Disconnected';
    document.getElementById('sb-connection-status').style.color = isConnected() ? 'var(--success)' : 'var(--danger)';
  });

  cancelBtn.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  connectBtn.addEventListener('click', async () => {
    const url = document.getElementById('sb-url').value.trim();
    const key = document.getElementById('sb-key').value.trim();
    
    if (!url || !key) {
      saveCredentials('', '');
      showToast('Database Sync disconnected', 'info');
      modal.classList.remove('active');
      await loadState();
      renderAll();
      drawRouteOnMap();
      return;
    }

    const statusEl = document.getElementById('sb-connection-status');
    statusEl.textContent = 'Connecting...';
    statusEl.style.color = 'var(--text-muted)';

    const res = await testConnection(url, key);
    if (res.ok) {
      showToast('Supabase successfully synced!', 'success');
      modal.classList.remove('active');
      
      await loadState();
      renderAll();
      drawRouteOnMap();
    } else {
      statusEl.textContent = `Error: ${res.message}`;
      statusEl.style.color = 'var(--danger)';
    }
  });
}

// ── Toast Notifications ──
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
