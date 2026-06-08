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

export function generateItinerary(destinations, days, travelStyle, startLocation = null) {
  if (destinations.length === 0) return {};

  // Sort destinations using a nearest-neighbor clustering approach
  const unvisited = [...destinations];
  const sorted = [];
  let currentPoint = startLocation || { lat: unvisited[0].lat, lng: unvisited[0].lng };

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const dist = getDistance(currentPoint, unvisited[i]);
      if (dist < minDist) {
        minDist = dist;
        nearestIdx = i;
      }
    }
    const nextPlace = unvisited.splice(nearestIdx, 1)[0];
    sorted.push(nextPlace);
    currentPoint = { lat: nextPlace.lat, lng: nextPlace.lng };
  }

  // Determine starting hour and items per day based on travel style
  let startMinutes = 600; // 10:00 AM default
  let placesPerDay = 2;
  let travelBuffer = 30; // 30 mins between places

  if (travelStyle === 'relaxed') {
    startMinutes = 630; // 10:30 AM
    placesPerDay = 2;
    travelBuffer = 45;
  } else if (travelStyle === 'balanced') {
    startMinutes = 570; // 09:30 AM
    placesPerDay = 3;
    travelBuffer = 30;
  } else if (travelStyle === 'packed') {
    startMinutes = 510; // 08:30 AM
    placesPerDay = 5;
    travelBuffer = 20;
  }

  const itinerary = {};
  for (let d = 1; d <= days; d++) {
    itinerary[d] = [];
  }

  // Distribute places across days
  let currentDay = 1;
  sorted.forEach((place, index) => {
    // Wrap to next day if threshold met
    if (itinerary[currentDay].length >= placesPerDay && currentDay < days) {
      currentDay++;
    }
    
    itinerary[currentDay].push({
      ...place,
      completed: false
    });
  });

  // Calculate schedule timings for each day
  for (let d = 1; d <= days; d++) {
    let currentTime = startMinutes;
    itinerary[d] = itinerary[d].map(item => {
      const scheduledTime = formatTime(currentTime);
      const duration = item.estTime || 90;
      const endTime = formatTime(currentTime + duration);
      
      const scheduledItem = {
        ...item,
        time: scheduledTime,
        endTime: endTime,
        startMinutes: currentTime,
        duration: duration
      };

      // Progress currentTime for next item
      currentTime += duration + travelBuffer;
      return scheduledItem;
    });
  }

  return itinerary;
}

// Recalculate all times for a single day after re-ordering
export function recalculateDaySchedule(dayPlaces, startMinutes = null) {
  if (!dayPlaces || dayPlaces.length === 0) return [];

  // Default start is the start time of the first item, or 9:30 AM
  let currentTime = startMinutes !== null ? startMinutes : (dayPlaces[0].startMinutes || 570);
  const travelBuffer = 30;

  return dayPlaces.map(item => {
    const scheduledTime = formatTime(currentTime);
    const duration = item.duration || item.estTime || 90;
    const endTime = formatTime(currentTime + duration);
    
    const updated = {
      ...item,
      time: scheduledTime,
      endTime: endTime,
      startMinutes: currentTime,
      duration: duration
    };
    currentTime += duration + travelBuffer;
    return updated;
  });
}

// Suggest itinerary adjustments if user reports a delay
export function suggestAdjustmentForDelay(dayPlaces, activeItemIndex, actualMinutes) {
  const currentItem = dayPlaces[activeItemIndex];
  if (!currentItem) return dayPlaces;

  const plannedStart = currentItem.startMinutes;
  const delayMinutes = actualMinutes - plannedStart;

  if (delayMinutes <= 15) {
    // Negligible delay
    return { adjusted: false, schedule: dayPlaces };
  }

  // Create adjusted schedule by pushing all remaining times
  let currentTime = actualMinutes;
  const travelBuffer = 20; // Reduce travel buffer slightly to optimize/catch up

  const adjustedSchedule = dayPlaces.map((item, idx) => {
    // If completed or before active item, keep original
    if (idx < activeItemIndex) {
      return item;
    }

    const duration = item.duration || item.estTime || 90;
    const scheduledTime = formatTime(currentTime);
    const endTime = formatTime(currentTime + duration);
    
    // Check if it exceeds standard opening hours (e.g. 6:30 PM = 1110 mins)
    let warning = false;
    if (item.hours && item.hours !== '2-digit' && item.hours !== '24 Hours') {
      // Basic check: if opening hours close at 6:00 PM (1080 mins) or similar
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

    currentTime += duration + travelBuffer;
    return updated;
  });

  return {
    adjusted: true,
    delayAmount: delayMinutes,
    schedule: adjustedSchedule
  };
}
