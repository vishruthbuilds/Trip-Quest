// ═══════════════════════════════════════════════════════════
// TripQuest · App Orchestrator
// ═══════════════════════════════════════════════════════════

import {
  isConnected, testConnection, getCredentials, saveCredentials,
  loadActiveTrip, saveActiveTrip, loadDestinations, saveDestinations
} from './supabase.js';

// ── In-Memory Application State ──────────────────────────
const State = {
  trip: { id: 'local_trip_id', name: 'My Goa Itinerary' },
  importedPlaces: [], // List of places available to add
  destinations: [],   // Active itinerary list
  isSimulating: false,
  simulatedMinutes: 720, // 12:00 PM
  map: null,
  markersLayer: null,
  routeLine: null,
  activeStopIndex: null,
  isTransit: false,
  transitFrom: null,
  transitTo: null
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
  // 1. Initial State Load
  await loadState();

  // 2. Bind UI Event Listeners
  bindEvents();

  // 3. Initialize Leaflet Map
  initLeafletMap();

  // 4. Render Initial Views
  renderAll();

  // 5. Start Clock Ticker
  startClock();
});

// ── Load & Save State ─────────────────────────────────────
async function loadState() {
  // Load saved places pool
  try {
    const rawSaved = localStorage.getItem('tq_imported_places');
    State.importedPlaces = rawSaved ? JSON.parse(rawSaved) : [];
  } catch (e) {
    State.importedPlaces = [];
  }

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
  
  // Backwards compatibility/fallback: ensure all destinations have duration and category
  State.destinations.forEach((d, idx) => {
    if (!d.id) d.id = 'dest_' + idx + '_' + Date.now();
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
  // Recalculate timings sequentially starting from the first stop's time
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
    // Fallback: Try reading HH:MM 24h format
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
 * Automatically sequences all stops sequentially starting from the first stop's time.
 * Calculates transit times between consecutive stops.
 */
function recalculateScheduleTimings() {
  if (State.destinations.length === 0) return;

  // Set the start time of the first stop to whatever is currently entered
  let currentTime = parseTimeToMinutes(State.destinations[0].time);
  State.destinations[0].time = formatMinutes(currentTime);

  for (let i = 0; i < State.destinations.length; i++) {
    const stop = State.destinations[i];
    
    // Assign calculated start time to this stop
    stop.time = formatMinutes(currentTime);
    
    // Add visit duration
    const duration = parseInt(stop.duration) || 60;
    
    if (i < State.destinations.length - 1) {
      // Calculate transit time to the next stop
      const nextStop = State.destinations[i + 1];
      const dist = haversineKm(stop.lat, stop.lng, nextStop.lat, nextStop.lng);
      const isWalking = dist < 1.2;
      // walking speed ~5km/h = 12min/km, driving speed ~30km/h = 2min/km
      const speed = isWalking ? 5 : 30;
      const transitMins = Math.max(5, Math.round((dist / speed) * 60));
      
      // Update next stop's start time by adding duration + transit buffer
      currentTime += duration + transitMins;
    }
  }
}

// ── Geodesic Distance Helpers ─────────────────────────────
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
  renderTimeline();
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

  if (State.destinations.length === 0) {
    container.innerHTML = '<div class="timeline-empty-hint">Add places from your Saved Places pool.</div>';
    return;
  }

  container.innerHTML = '';
  State.destinations.forEach((stop, idx) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'timeline-stop-wrapper';
    wrapper.dataset.index = idx;
    
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
              <input type="text" class="input-time-schedule" data-idx="${idx}" value="${stop.time}" ${idx > 0 ? 'disabled' : ''} placeholder="e.g. 10:00 AM">
            </div>
            <div class="time-input-wrap">
              <span>Duration</span>
              <input type="number" class="input-duration" data-idx="${idx}" min="5" max="480" value="${stop.duration}">
              <span>min</span>
            </div>
          </div>
        </div>
        <button class="btn-delete-stop" data-idx="${idx}" title="Remove stop">✕</button>
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
    if (idx < State.destinations.length - 1) {
      const nextStop = State.destinations[idx + 1];
      const dist = haversineKm(stop.lat, stop.lng, nextStop.lat, nextStop.lng);
      const transit = estimateTransit(dist);

      const transitNode = document.createElement('div');
      transitNode.className = 'timeline-transit-node';
      transitNode.innerHTML = `
        <span class="transit-icon">${transit.mode.split(' ')[0]}</span>
        <span class="transit-details">${transit.mode.split(' ')[1]} ${formatDistance(dist)} (${transit.desc})</span>
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
        // Swap or move elements
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

  // Generate a unique ID
  const newStop = {
    id: 'dest_' + Math.random().toString(36).substr(2, 9),
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    maps_url: place.maps_url || '',
    category: place.category || 'Attraction',
    time: State.destinations.length === 0 ? '09:00 AM' : '', // Seq auto calculated
    duration: 90
  };

  State.destinations.push(newStop);
  saveItineraryState();
  showToast(`📍 Added "${place.name}" to itinerary!`, 'success');
}

function removePlaceFromItinerary(idx) {
  const removed = State.destinations.splice(idx, 1)[0];
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

// ── Leaflet Map Controls ──────────────────────────────────
function initLeafletMap() {
  const center = State.destinations.length > 0 
    ? [State.destinations[0].lat, State.destinations[0].lng] 
    : [15.5523, 73.7771]; // Default to Goa

  State.map = L.map('map-container', {
    zoomControl: false,
    scrollWheelZoom: true
  }).setView(center, 12);

  // CartoDB Voyager tiles - very playful, clean, matching a colorful design system!
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CartoDB',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(State.map);

  L.control.zoom({
    position: 'bottomright'
  }).addTo(State.map);

  State.markersLayer = L.layerGroup().addTo(State.map);

  drawRouteOnMap();
}

function drawRouteOnMap() {
  if (!State.map || !State.markersLayer) return;

  State.markersLayer.clearLayers();
  if (State.routeLine) {
    State.map.removeLayer(State.routeLine);
    State.routeLine = null;
  }

  if (State.destinations.length === 0) return;

  const latlngs = [];
  State.destinations.forEach((stop, idx) => {
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
    
    // Custom popup content
    const emoji = CategoryEmojis[stop.category] || '📍';
    const popupContent = `
      <div class="map-popup-card">
        <h4>${emoji} ${stop.name}</h4>
        <p>Category: <b>${stop.category}</b></p>
        <p>Arrival: <b>${stop.time}</b> (${stop.duration} mins)</p>
        ${stop.maps_url ? `<p style="margin-top:5px;"><a href="${stop.maps_url}" target="_blank" style="color:var(--primary); text-decoration:none; font-weight:600;">View on Google Maps ↗</a></p>` : ''}
      </div>
    `;

    marker.bindPopup(popupContent);
    State.markersLayer.addLayer(marker);
  });

  // Connecting route line
  if (latlngs.length > 1) {
    State.routeLine = L.polyline(latlngs, {
      color: '#FF6B4A',
      weight: 4,
      opacity: 0.8,
      dashArray: '8, 8',
      lineJoin: 'round'
    }).addTo(State.map);

    // Zoom map to show entire path bounds
    try {
      State.map.fitBounds(State.routeLine.getBounds(), { padding: [50, 50] });
    } catch (e) {
      console.warn('Map fit bounds issue:', e);
    }
  } else if (latlngs.length === 1) {
    State.map.setView(latlngs[0], 14);
  }
}

// ── Google Maps Shared List / Place URL Scraper ───────────
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

  // Process input line-by-line
  const lines = inputStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if it's a URL
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
          // If URL scrape fails to find coords, fall back to searching the name via geocoding
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
        console.warn('URL scraping failed, trying text-search fallback...', e);
        // Extract possible query names from typical Google Maps URLs
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
      // It's a text search
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
      // Delay to respect OSM Nominatim rate limit (1 request/second)
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Save imported places pool to localstorage
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
    // Matches patterns like .../place/Place+Name/...
    const placeMatch = decoded.match(/maps\/place\/([^/@]+)/);
    if (placeMatch) return placeMatch[1].replace(/\+/g, ' ');

    // Matches search query parameters
    const queryMatch = decoded.match(/query=([^&]+)/) || decoded.match(/q=([^&]+)/);
    if (queryMatch) return queryMatch[1].replace(/\+/g, ' ');
  } catch (e) {}
  return null;
}

/** Parses Google Maps URL using CORS Proxy */
async function scrapeGoogleMapsUrl(url) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('CORS Proxy failed');

  const json = await res.json();
  const html = json.contents || '';
  const finalUrl = json.status?.url || url;

  // Extract name from HTML title
  let name = '';
  const titleMatch = html.match(/<title[^>]*>([^<|·]+)/i);
  if (titleMatch) {
    name = titleMatch[1].replace(/\s*[-|·]\s*Google Maps.*$/i, '').trim();
  }
  if (!name || name.toLowerCase().includes('google maps')) {
    const extracted = extractNameFromMapsUrl(finalUrl);
    if (extracted) name = extracted;
  }

  // Extract coordinates
  let lat = null, lng = null;
  // Look for patterns like @15.5523,73.7771
  const coordsMatch = (finalUrl + html).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (coordsMatch) {
    lat = parseFloat(coordsMatch[1]);
    lng = parseFloat(coordsMatch[2]);
  } else {
    // Alternate format: [null,null,lat,lng] inside JS
    const altCoordsMatch = html.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
    if (altCoordsMatch) {
      lat = parseFloat(altCoordsMatch[1]);
      lng = parseFloat(altCoordsMatch[2]);
    }
  }

  return { name: name || 'Google Maps Place', lat, lng };
}

/** Geocodes place name using OpenStreetMap Nominatim API */
async function geocodeTextName(name) {
  const cleanQuery = name.trim();
  const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanQuery)}&limit=1`;
  
  const res = await fetch(searchUrl, {
    headers: {
      'Accept-Language': 'en',
      // Nominatim requires a user-agent to prevent blocking
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

// ── Real-Time Tracking Core ──────────────────────────────
function startClock() {
  // Run every second
  setInterval(() => {
    let activeMinutes;
    
    if (State.isSimulating) {
      activeMinutes = State.simulatedMinutes;
    } else {
      activeMinutes = getCurrentMinutesFromMidnight();
    }

    // Update digital clock display
    const clockEl = document.getElementById('clock-display');
    if (clockEl) {
      clockEl.textContent = formatMinutes(activeMinutes);
    }

    // Determine current stop status
    evaluateCurrentStopStatus(activeMinutes);
  }, 1000);
}

function evaluateCurrentStopStatus(activeTime) {
  if (State.destinations.length === 0) {
    updateActiveStopUI(null, false);
    return;
  }

  let matchedIdx = null;
  let isTransit = false;
  let transitFrom = null;
  let transitTo = null;

  const firstStopStart = parseTimeToMinutes(State.destinations[0].time);
  
  if (activeTime < firstStopStart) {
    // Before trip starts
    updateActiveStopUI({
      type: 'upcoming',
      nextStop: State.destinations[0]
    });
    return;
  }

  for (let i = 0; i < State.destinations.length; i++) {
    const stop = State.destinations[i];
    const start = parseTimeToMinutes(stop.time);
    const end = start + (parseInt(stop.duration) || 60);

    // Check if active time matches this stop duration
    if (activeTime >= start && activeTime <= end) {
      matchedIdx = i;
      break;
    }

    // Check if active time falls between this stop and the next
    if (i < State.destinations.length - 1) {
      const nextStop = State.destinations[i + 1];
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
    // Stop is active
    const activeStop = State.destinations[matchedIdx];
    const endMins = parseTimeToMinutes(activeStop.time) + (parseInt(activeStop.duration) || 60);
    const remaining = endMins - activeTime;

    updateActiveStopUI({
      type: 'active',
      stop: activeStop,
      index: matchedIdx,
      remainingText: `ends in ${remaining} mins`
    });
  } else if (isTransit) {
    // Currently traveling
    const nextStart = parseTimeToMinutes(transitTo.time);
    const remaining = nextStart - activeTime;
    const dist = haversineKm(transitFrom.lat, transitFrom.lng, transitTo.lat, transitTo.lng);
    const transit = estimateTransit(dist);

    updateActiveStopUI({
      type: 'transit',
      from: transitFrom,
      to: transitTo,
      remainingText: `Arriving in ~${remaining} min (${formatDistance(dist)} ${transit.mode.split(' ')[0]})`
    });
  } else {
    // Past last stop
    updateActiveStopUI({
      type: 'completed'
    });
  }
}

let lastActiveIndex = null;
let lastIsTransit = null;

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
    timeDesc.textContent = `${status.stop.time} - ${formatMinutes(parseTimeToMinutes(status.stop.time) + parseInt(status.stop.duration))} (${status.remainingText})`;
    
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

  // Highlight timeline active nodes & marker animations if state transitions
  if (changed || forceMapDraw) {
    // 1. Re-render timeline to highlight active card
    renderTimeline();

    // 2. Redraw map to update pulsing active marker
    drawRouteOnMap();

    // 3. Center map on active location
    if (status.type === 'active' && State.map) {
      State.map.setView([status.stop.lat, status.stop.lng], 14);
    } else if (status.type === 'transit' && State.map) {
      // Zoom map to show the bounds between the transit points
      const bounds = L.latLngBounds(
        [status.from.lat, status.from.lng],
        [status.to.lat, status.to.lng]
      );
      State.map.fitBounds(bounds, { padding: [100, 100] });
    }
  }
}

// ── Event Bindings ────────────────────────────────────────
function bindEvents() {
  // Import click
  document.getElementById('btn-import').addEventListener('click', importFromInput);

  // Save Trip Details
  document.getElementById('trip-name').addEventListener('change', saveTripDetails);

  // Modal Setup
  const setupBtn = document.getElementById('btn-open-sb-setup');
  const modal = document.getElementById('modal-supabase');
  const cancelBtn = document.getElementById('btn-sb-cancel');
  const connectBtn = document.getElementById('btn-sb-connect');

  setupBtn.addEventListener('click', () => {
    modal.classList.add('active');
    // Pre-fill
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
      // Clear credentials (disconnect)
      saveCredentials('', '');
      showToast('Database Sync disconnected (running offline)', 'info');
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
      
      // Reload everything to pull from DB
      await loadState();
      renderAll();
      drawRouteOnMap();
    } else {
      statusEl.textContent = `Error: ${res.message}`;
      statusEl.style.color = 'var(--danger)';
    }
  });

  // Time simulation controls
  const toggle = document.getElementById('sim-time-toggle');
  const sliderRow = document.getElementById('sim-slider-row');
  const slider = document.getElementById('sim-time-slider');
  const sliderLabel = document.getElementById('sim-time-label');
  const modeBadge = document.getElementById('tracker-mode-badge');

  toggle.addEventListener('change', (e) => {
    State.isSimulating = e.target.checked;
    if (State.isSimulating) {
      sliderRow.style.display = 'block';
      modeBadge.textContent = 'Simulated';
      modeBadge.classList.add('simulated');
      
      // Set slider to current actual time first
      const currentMin = getCurrentMinutesFromMidnight();
      slider.value = currentMin;
      State.simulatedMinutes = currentMin;
      sliderLabel.textContent = formatMinutes(currentMin);
    } else {
      sliderRow.style.display = 'none';
      modeBadge.textContent = 'Real-Time';
      modeBadge.classList.remove('simulated');
    }
    // Instantly refresh UI
    evaluateCurrentStopStatus(State.isSimulating ? State.simulatedMinutes : getCurrentMinutesFromMidnight());
  });

  slider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    State.simulatedMinutes = val;
    sliderLabel.textContent = formatMinutes(val);
    evaluateCurrentStopStatus(val);
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
