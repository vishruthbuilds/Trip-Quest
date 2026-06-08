// Smart Itinerary Generator and Adjuster for TripQuest

// Helper to calculate Euclidean distance between two coordinates
function getDistance(p1, p2) {
  return Math.sqrt(Math.pow(p1.lat - p2.lat, 2) + Math.pow(p1.lng - p2.lng, 2));
}

// Format minutes from midnight to a 12-hour AM/PM string
export function formatTime(minutes) {
  const hrs = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const ampm = hrs >= 12 ? 'PM' : 'AM';
  const displayHrs = hrs % 12 || 12;
  const displayMins = mins < 10 ? '0' + mins : mins;
  return `${displayHrs}:${displayMins} ${ampm}`;
}

// Parse "HH:MM AM/PM" into minutes from midnight
export function parseTime(timeStr) {
  const match = timeStr.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return 600; // default 10:00 AM
  let hrs = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hrs < 12) hrs += 12;
  if (ampm === 'AM' && hrs === 12) hrs = 0;
  return hrs * 60 + mins;
}

export function kMeansClustering(places, k) {
  if (places.length === 0) return [];
  if (places.length <= k) {
    return places.map((p, idx) => ({ ...p, clusterId: idx }));
  }

  // Initialize centroids spread out across the places array
  const centroids = [];
  const step = Math.floor(places.length / k);
  for (let i = 0; i < k; i++) {
    const idx = Math.min(i * step, places.length - 1);
    centroids.push({ lat: places[idx].lat, lng: places[idx].lng });
  }

  let assignments = Array(places.length).fill(-1);
  let changed = true;
  let maxIter = 100;

  while (changed && maxIter > 0) {
    changed = false;
    maxIter--;

    // Assign places to nearest centroid
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      let minDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < k; c++) {
        const dist = Math.sqrt(Math.pow(p.lat - centroids[c].lat, 2) + Math.pow(p.lng - centroids[c].lng, 2));
        if (dist < minDist) {
          minDist = dist;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed = true;
      }
    }

    // Recompute centroids
    const sums = Array(k).fill(null).map(() => ({ lat: 0, lng: 0, count: 0 }));
    for (let i = 0; i < places.length; i++) {
      const c = assignments[i];
      sums[c].lat += places[i].lat;
      sums[c].lng += places[i].lng;
      sums[c].count++;
    }

    for (let c = 0; c < k; c++) {
      if (sums[c].count > 0) {
        centroids[c] = {
          lat: sums[c].lat / sums[c].count,
          lng: sums[c].lng / sums[c].count
        };
      }
    }
  }

  return places.map((p, idx) => ({
    ...p,
    clusterId: assignments[idx]
  }));
}

// Distance helper in Kilometers (Haversine formula)
export function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

// TSP Heuristic route planner starting and ending at the Hotel
export function optimizeRoute(dayPlaces, hotel, endAtHotel = true, travelStyle = 'balanced') {
  if (!dayPlaces || dayPlaces.length === 0) return [];
  
  // Exclude any existing start/end hotel placeholders so we don't double count
  const sightsOnly = dayPlaces.filter(p => p.id !== 'hotel-start' && p.id !== 'hotel-end');
  
  if (sightsOnly.length === 0) return [];

  const unvisited = [...sightsOnly];
  const sorted = [];
  
  // Starting point is the hotel if specified, else first place
  let currentPoint = hotel ? { lat: hotel.lat, lng: hotel.lng } : { lat: unvisited[0].lat, lng: unvisited[0].lng };

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const dist = getDistanceInKm(currentPoint.lat, currentPoint.lng, unvisited[i].lat, unvisited[i].lng);
      if (dist < minDist) {
        minDist = dist;
        nearestIdx = i;
      }
    }
    const nextPlace = unvisited.splice(nearestIdx, 1)[0];
    sorted.push(nextPlace);
    currentPoint = { lat: nextPlace.lat, lng: nextPlace.lng };
  }

  // Determine starting hour and transit buffers based on travel style
  let startMinutes = 570; // 09:30 AM default
  if (travelStyle === 'relaxed') {
    startMinutes = 630; // 10:30 AM
  } else if (travelStyle === 'balanced') {
    startMinutes = 570; // 09:30 AM
  } else if (travelStyle === 'packed') {
    startMinutes = 510; // 08:30 AM
  }

  const schedule = [];
  let currentTime = startMinutes;

  // 1. Add Hotel Start Marker if hotel is set
  if (hotel) {
    schedule.push({
      id: 'hotel-start',
      name: `🏨 Start: ${hotel.name}`,
      lat: hotel.lat,
      lng: hotel.lng,
      category: 'Hotel',
      time: formatTime(currentTime),
      endTime: formatTime(currentTime + 15),
      startMinutes: currentTime,
      duration: 15,
      description: 'Starting base point. Gear up for the adventure!',
      completed: true
    });
    currentTime += 15;
  }

  // 2. Add Sights with transit calculation
  let prevPoint = hotel ? { lat: hotel.lat, lng: hotel.lng } : { lat: sorted[0].lat, lng: sorted[0].lng };
  sorted.forEach((place, idx) => {
    const distKm = getDistanceInKm(prevPoint.lat, prevPoint.lng, place.lat, place.lng);
    const isWalking = distKm < 1.2; // Walk mode threshold
    const transitTime = isWalking ? Math.max(8, Math.round(distKm * 15)) : 12; // walking speed ~4km/h = 15min/km
    
    currentTime += transitTime;

    const duration = place.estTime || place.duration || 90;
    schedule.push({
      ...place,
      time: formatTime(currentTime),
      endTime: formatTime(currentTime + duration),
      startMinutes: currentTime,
      duration: duration,
      completed: place.completed || false,
      transitMode: isWalking ? 'Walk 🚶' : 'Drive 🚗',
      transitDuration: transitTime,
      distanceFromPrev: distKm
    });

    currentTime += duration;
    prevPoint = { lat: place.lat, lng: place.lng };
  });

  // 3. Add Hotel End Marker
  if (hotel && endAtHotel) {
    const distKm = getDistanceInKm(prevPoint.lat, prevPoint.lng, hotel.lat, hotel.lng);
    const isWalking = distKm < 1.2;
    const transitTime = isWalking ? Math.max(8, Math.round(distKm * 15)) : 12;
    currentTime += transitTime;

    schedule.push({
      id: 'hotel-end',
      name: `🏨 End: Back to ${hotel.name}`,
      lat: hotel.lat,
      lng: hotel.lng,
      category: 'Hotel',
      time: formatTime(currentTime),
      endTime: formatTime(currentTime + 15),
      startMinutes: currentTime,
      duration: 15,
      description: 'Day quest complete. Head back to sleep, sync memories and review points!',
      completed: false,
      transitMode: isWalking ? 'Walk 🚶' : 'Drive 🚗',
      transitDuration: transitTime,
      distanceFromPrev: distKm
    });
  }

  return schedule;
}

// Recalculate schedule times for a day based on local edits/delays
export function recalculateDaySchedule(dayPlaces, startMinutes = null) {
  if (!dayPlaces || dayPlaces.length === 0) return [];

  // Exclude hotel placeholders if present, they will be regenerated relative to the hotel
  const hotelStart = dayPlaces.find(p => p.id === 'hotel-start');
  const hotelEnd = dayPlaces.find(p => p.id === 'hotel-end');
  const hotelObj = hotelStart ? { name: hotelStart.name.replace('🏨 Start: ', ''), lat: hotelStart.lat, lng: hotelStart.lng } : null;

  const sights = dayPlaces.filter(p => p.id !== 'hotel-start' && p.id !== 'hotel-end');
  
  // Run optimizeRoute on remaining sights to guarantee clean sequence timings
  return optimizeRoute(sights, hotelObj, !!hotelEnd);
}

// Suggest itinerary adjustments if user reports a delay
export function suggestAdjustmentForDelay(dayPlaces, activeItemIndex, actualMinutes) {
  const currentItem = dayPlaces[activeItemIndex];
  if (!currentItem) return { adjusted: false, schedule: dayPlaces };

  const plannedStart = currentItem.startMinutes;
  const delayMinutes = actualMinutes - plannedStart;

  if (delayMinutes <= 15) {
    return { adjusted: false, schedule: dayPlaces };
  }

  let currentTime = actualMinutes;
  const adjustedSchedule = dayPlaces.map((item, idx) => {
    if (idx < activeItemIndex) {
      return item;
    }

    // Skip recalculating completed items (already done)
    const duration = item.duration || 90;
    const scheduledTime = formatTime(currentTime);
    const endTime = formatTime(currentTime + duration);

    let warning = false;
    if (item.hours && item.hours !== '24 Hours') {
      const closeMatch = item.hours.match(/-\s*(\d+):(\d+)\s*(AM|PM)$/i);
      if (closeMatch) {
        let closeHrs = parseInt(closeMatch[1]);
        const closeMins = parseInt(closeMatch[2]);
        const closeAmpm = closeMatch[3].toUpperCase();
        if (closeAmpm === 'PM' && closeHrs < 12) closeHrs += 12;
        const closeTimeMins = closeHrs * 60 + closeMins;
        if (currentTime + duration > closeTimeMins) {
          warning = true;
        }
      }
    }

    const updated = {
      ...item,
      time: scheduledTime,
      endTime: endTime,
      startMinutes: currentTime,
      warning: warning,
      warningMsg: warning ? `⚠️ May close before you finish!` : null
    };

    const transitBuffer = item.transitDuration || 15;
    currentTime += duration + transitBuffer;
    return updated;
  });

  return {
    adjusted: true,
    delayAmount: delayMinutes,
    schedule: adjustedSchedule
  };
}

