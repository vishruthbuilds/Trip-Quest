# TripQuest 🧭

TripQuest is a mobile-first multiplayer travel game that turns planning and exploring trips with friends into a competitive, interactive adventure!

## Features

- **Google Maps Saved Lists Import**: Simulated Google sign-in allows hosts to import saved places lists, fetching photos, ratings, opening hours, and coordinates.
- **Smart Itinerary Generator**: Groups nearby places, optimizes route layout, respects opening hours, and formats schedules according to travel styles (Relaxed, Balanced, Packed).
- **Real-Time Cross-Tab Sync**: Uses HTML5 localStorage reactive syncing. You can open two browser tabs side-by-side (one Host, one Member) and watch messages, spins, check-ins, and Bingo completions synchronize in real time!
- **Play & Quest Hub**:
  - **Travel Bingo**: A customized interactive grid of travel goals.
  - **Spin Wheel**: Physical canvas-based wheel displaying members' avatars. Spin to assign random challenges!
  - **Secret Missions**: Hidden personal tasks. Complete them to surprise the group and earn bonus points.
- **Travel Simulator Controls**: Trigger 2-hour delay recalculation prompts, or simulate friends joining your lobby for offline demonstration.

## Getting Started

### 1. Install & Launch Dev Server

Ensure you have Node.js installed, then run:

```bash
# Start local server on port 3000
npm run dev
```

Then open your browser to [http://localhost:3000](http://localhost:3000).

### 2. How to Test Multiplayer Real-Time Sync

1. Open **Tab A** ([http://localhost:3000](http://localhost:3000)).
   - Set avatar to 🦊, name to "Alice", and select **Team Red**.
   - Click **Create Trip (Host)**.
   - Connect Google, pick a saved list (e.g. *Goa Beach & Culture Adventure*), choose parameters, and click **Generate Smart Itinerary**.
   - Copy the generated Trip Code (e.g. `QUEST-1234`) displayed on the Itinerary tab.
2. Open **Tab B** in a separate window or side-by-side tab.
   - Set avatar to 🐼, name to "Bob", and select **Team Blue**.
   - Click **Join Existing Trip Room**.
   - Enter the Code and click **Connect**.
3. **Try Sync Activities**:
   - Send chat messages from Tab A and verify they appear instantly in Tab B.
   - Select a challenge and spin the wheel in Tab A. Watch the wheel spin and land on the same participant on both screens in real time.
   - Tick a bingo box in Tab B and see Tab A instantly show a toast notification + update the leaderboard!

### 3. How to Connect a Supabase Cloud Database

To transition from local fallback sync to actual real-time database sync across separate devices and networks:

1. Create a free project at **[Supabase](https://supabase.com)**.
2. Go to the **SQL Editor** in your Supabase Dashboard and click **New Query**.
3. Paste the following SQL script to create the required tables and enable Realtime broadcasts, then click **Run**:

```sql
-- Create Trips Table
CREATE TABLE IF NOT EXISTS public.trips (
  code text PRIMARY KEY,
  name text NOT NULL,
  start_date date,
  days integer DEFAULT 1,
  style text,
  destinations jsonb DEFAULT '[]'::jsonb,
  itinerary jsonb DEFAULT '{}'::jsonb,
  active_challenge jsonb,
  teams jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create Players Table
CREATE TABLE IF NOT EXISTS public.players (
  id text PRIMARY KEY,
  trip_code text REFERENCES public.trips(code) ON DELETE CASCADE,
  name text NOT NULL,
  avatar text,
  team text,
  xp integer DEFAULT 0,
  level integer DEFAULT 1,
  bingo_card jsonb DEFAULT '[]'::jsonb,
  secret_mission_id text,
  secret_mission_completed boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create Chat Messages Table
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_code text REFERENCES public.trips(code) ON DELETE CASCADE,
  sender text NOT NULL,
  avatar text,
  text text NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create Gallery Photos Table
CREATE TABLE IF NOT EXISTS public.gallery_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_code text REFERENCES public.trips(code) ON DELETE CASCADE,
  url text NOT NULL,
  caption text,
  uploaded_by text,
  category text,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Realtime for all tables
alter publication supabase_realtime add table trips;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table chat_messages;
alter publication supabase_realtime add table gallery_photos;
```

4. In the **TripQuest** app, click the **⚡** icon in the header.
5. Paste your **Project URL** and **API Anon Key** (found under *Project Settings -> API* in Supabase).
6. Click **Connect! 🔌** and watch the status turn green!

