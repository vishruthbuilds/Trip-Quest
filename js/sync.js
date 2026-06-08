// Real-Time Cross-Tab Synchronization Engine
import { state } from './state.js';

export function initializeSync() {
  window.addEventListener('storage', (event) => {
    // If the database has been updated by another tab
    if (event.key === state.storageKey && event.newValue) {
      try {
        const newDB = JSON.parse(event.newValue);
        state.syncStateFromExternal(newDB);
        
        // Dispatch custom sync event for UI triggers (like notification sounds or popups)
        const customEvent = new CustomEvent('tripquest_synced', {
          detail: { db: newDB }
        });
        window.dispatchEvent(customEvent);
      } catch (err) {
        console.error('Error parsing synced state:', err);
      }
    }

    // If active trip changed in another tab
    if (event.key === state.activeTripKey && event.newValue) {
      state.activeTripCode = event.newValue;
      state.notify();
    }
  });

  // Periodically emit a heartbeat or log for troubleshooting
  console.log('TripQuest Real-Time Sync Engine Initialized.');
}
