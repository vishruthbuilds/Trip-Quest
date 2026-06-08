// Interactive Leaflet.js Map integration for TripQuest
let mapInstance = null;
let markersLayer = null;
let routeLine = null;

export function initMap(elementId, center = [15.4989, 73.8342], zoom = 11) {
  const mapElement = document.getElementById(elementId);
  if (!mapElement) return null;

  // Destroy existing instance if active to avoid re-init error
  if (mapInstance) {
    try {
      mapInstance.remove();
    } catch (e) {
      console.warn('Map cleanup warning:', e);
    }
  }

  // Set up map
  mapInstance = L.map(elementId, {
    zoomControl: false,
    scrollWheelZoom: true
  }).setView(center, zoom);

  // CartoDB Voyager tiles - very playful, clean, matching a colorful design system!
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CartoDB',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(mapInstance);

  L.control.zoom({
    position: 'bottomright'
  }).addTo(mapInstance);

  markersLayer = L.layerGroup().addTo(mapInstance);

  return mapInstance;
}

export function drawItineraryRoute(destinations) {
  if (!mapInstance || !markersLayer) return;

  // Clear previous markers & lines
  markersLayer.clearLayers();
  if (routeLine) {
    mapInstance.removeLayer(routeLine);
  }

  if (!destinations || destinations.length === 0) return;

  const latlngs = [];

  destinations.forEach((place, index) => {
    const coords = [place.lat, place.lng];
    latlngs.push(coords);

    // Playful custom marker icon using divIcon
    const customIcon = L.divIcon({
      html: `
        <div class="custom-map-pin animate__animated animate__bounceIn" style="background-color: ${getCategoryColor(place.category)}">
          <span class="pin-number">${index + 1}</span>
        </div>
      `,
      className: 'custom-leaflet-icon',
      iconSize: [36, 36],
      iconAnchor: [18, 36]
    });

    const marker = L.marker(coords, { icon: customIcon });
    
    // Custom popup
    const popupContent = `
      <div class="map-popup-card">
        <img src="${place.photo}" alt="${place.name}" class="popup-img" />
        <div class="popup-details">
          <h4>${place.name}</h4>
          <span class="popup-category">${place.category || 'Sight'}</span>
          <div class="popup-rating">⭐ ${place.rating || 'N/A'}</div>
          <p>${place.description || ''}</p>
        </div>
      </div>
    `;

    marker.bindPopup(popupContent);
    markersLayer.addLayer(marker);
  });

  // Draw dashed route path line connecting locations
  if (latlngs.length > 1) {
    routeLine = L.polyline(latlngs, {
      color: '#FF6B4A',
      weight: 4,
      opacity: 0.8,
      dashArray: '8, 8',
      lineJoin: 'round'
    }).addTo(mapInstance);

    // Zoom out map to show entire path bounds
    try {
      mapInstance.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
    } catch (e) {
      console.warn('Map fit bounds issue:', e);
    }
  } else if (latlngs.length === 1) {
    mapInstance.setView(latlngs[0], 13);
  }
}

// Draw simulated user positions on map
export function drawUserPins(members, activeDestinations) {
  if (!mapInstance || !markersLayer || !activeDestinations || activeDestinations.length === 0) return;

  members.forEach((m, idx) => {
    // Distribute members around the active destinations to simulate them moving/hanging out
    const basePlace = activeDestinations[idx % activeDestinations.length];
    
    // Add small random noise so avatars don't stack directly
    const offsetLat = (Math.random() - 0.5) * 0.005;
    const offsetLng = (Math.random() - 0.5) * 0.005;
    const coords = [basePlace.lat + offsetLat, basePlace.lng + offsetLng];

    const avatarIcon = L.divIcon({
      html: `
        <div class="player-map-avatar ${m.team === 'Red' ? 'border-red' : 'border-blue'}">
          <span class="player-emoji">${m.avatar}</span>
          <div class="player-name-bubble">${m.name}</div>
        </div>
      `,
      className: 'player-leaflet-icon',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    const marker = L.marker(coords, { icon: avatarIcon });
    marker.bindPopup(`<b>${m.avatar} ${m.name}</b> is on team <span style="color:${m.team === 'Red' ? '#EF4444' : '#3B82F6'}">${m.team}</span>!`);
    markersLayer.addLayer(marker);
  });
}

function getCategoryColor(category) {
  switch (category) {
    case 'Beach': return '#3B82F6'; // Blue
    case 'History': return '#8B5CF6'; // Purple
    case 'Nature': return '#10B981'; // Green
    case 'Food': return '#FF6B4A'; // Orange/Red
    case 'Culture': return '#EC4899'; // Pink
    default: return '#F59E0B'; // Yellow
  }
}

export function panToCoords(lat, lng) {
  if (mapInstance) {
    mapInstance.flyTo([lat, lng], 14, {
      animate: true,
      duration: 1.5
    });
  }
}
