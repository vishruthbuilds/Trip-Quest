// Game Mechanics: Bingo, Spin Wheel, Secret Missions
import { state } from './state.js';
import { travelBingoItems } from './mockData.js';

// Renders the travel Bingo 5x5 Grid
export function renderBingoBoard(containerId, userId, activeTrip) {
  const container = document.getElementById(containerId);
  if (!container || !activeTrip) return;

  container.innerHTML = '';
  const userBingo = activeTrip.bingo[userId] || Array(25).fill(false);

  // Bingo board is a 5x5 grid
  const grid = document.createElement('div');
  grid.className = 'bingo-grid';

  travelBingoItems.forEach((item, index) => {
    const tile = document.createElement('div');
    tile.className = `bingo-tile ${userBingo[index] ? 'completed' : ''}`;
    tile.innerHTML = `
      <div class="bingo-tile-content">
        <span class="bingo-tile-text">${item}</span>
        ${userBingo[index] ? '<span class="bingo-tile-check">✨</span>' : ''}
      </div>
    `;

    // Only allow clicking if player matches current user
    if (userId === state.user.id) {
      tile.addEventListener('click', () => {
        tile.classList.toggle('completed');
        // trigger confetti if checking
        if (!userBingo[index]) {
          triggerConfetti();
        }
        state.toggleBingoTile(index);
      });
    }

    grid.appendChild(tile);
  });

  container.appendChild(grid);
}

// Configures and triggers Spin Wheel physics/animation
export class SpinWheel {
  constructor(canvasId, spinBtnId, resultContainerId) {
    this.canvas = document.getElementById(canvasId);
    this.spinBtn = document.getElementById(spinBtnId);
    this.resultContainer = document.getElementById(resultContainerId);
    
    this.isSpinning = false;
    this.currentAngle = 0;
  }

  draw(participants) {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const width = this.canvas.width;
    const height = this.canvas.height;
    const radius = width / 2;
    ctx.clearRect(0, 0, width, height);

    if (participants.length === 0) {
      ctx.fillStyle = '#6B7280';
      ctx.textAlign = 'center';
      ctx.font = '16px Outfit, sans-serif';
      ctx.fillText('No participants found!', radius, radius);
      return;
    }

    const arcSize = (2 * Math.PI) / participants.length;
    const colors = ['#FF6B4A', '#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899', '#14B8A6'];

    participants.forEach((p, idx) => {
      const angle = this.currentAngle + idx * arcSize;
      
      // Draw slice
      ctx.beginPath();
      ctx.fillStyle = colors[idx % colors.length];
      ctx.moveTo(radius, radius);
      ctx.arc(radius, radius, radius - 10, angle, angle + arcSize);
      ctx.lineTo(radius, radius);
      ctx.fill();
      ctx.strokeWidth = 2;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // Draw avatar & label text
      ctx.save();
      ctx.translate(radius, radius);
      ctx.rotate(angle + arcSize / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 14px Outfit, sans-serif';
      
      // Truncate name if too long
      const displayName = p.name.length > 8 ? p.name.substring(0, 7) + '..' : p.name;
      ctx.fillText(`${p.avatar} ${displayName}`, radius - 25, 5);
      ctx.restore();
    });

    // Outer boundary border ring
    ctx.beginPath();
    ctx.arc(radius, radius, radius - 5, 0, 2 * Math.PI);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Center peg
    ctx.beginPath();
    ctx.arc(radius, radius, 15, 0, 2 * Math.PI);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = '#1E1E2E';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  spin(participants, challengeId, onComplete) {
    if (this.isSpinning || participants.length === 0) return;

    this.isSpinning = true;
    if (this.spinBtn) this.spinBtn.disabled = true;
    if (this.resultContainer) this.resultContainer.innerHTML = '🔮 Generating travel destiny...';

    const spinDuration = 3000; // 3 seconds
    const startAngle = this.currentAngle;
    const extraSpins = 5 + Math.random() * 5; // spins between 5 and 10 times
    const targetAddAngle = extraSpins * 2 * Math.PI;
    const startTime = performance.now();

    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / spinDuration, 1);
      
      // Easing out quadratic function
      const easeOut = 1 - Math.pow(1 - progress, 3);
      this.currentAngle = startAngle + easeOut * targetAddAngle;

      this.draw(participants);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        this.isSpinning = false;
        if (this.spinBtn) this.spinBtn.disabled = false;
        
        // Calculate which slice landed at the pointer (at 12 o'clock position = 1.5 * Math.PI or -Math.PI/2)
        // Normalize rotation back to [0, 2*PI]
        const normalizedAngle = (1.5 * Math.PI - this.currentAngle) % (2 * Math.PI);
        const positiveAngle = normalizedAngle < 0 ? normalizedAngle + 2 * Math.PI : normalizedAngle;
        
        const arcSize = (2 * Math.PI) / participants.length;
        const selectedIndex = Math.floor(positiveAngle / arcSize) % participants.length;
        const chosen = participants[selectedIndex];

        triggerConfetti();
        
        if (this.resultContainer) {
          this.resultContainer.innerHTML = `
            <div class="spin-result-card animate__animated animate__bounceIn">
              <span class="spin-result-avatar">${chosen.avatar}</span>
              <div class="spin-result-info">
                <h3>${chosen.name}</h3>
                <p>Must complete the challenge!</p>
              </div>
            </div>
          `;
        }

        if (onComplete) {
          onComplete(chosen);
        }
      }
    };

    requestAnimationFrame(animate);
  }
}

// Global Confetti helper
export function triggerConfetti() {
  if (window.confetti) {
    window.confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.8 },
      colors: ['#FF6B4A', '#3B82F6', '#8B5CF6', '#10B981', '#EC4899']
    });
  } else {
    console.log('Confetti triggered (library mock)!');
  }
}
