# Multi-Platform Chat Reader & OBS Overlay

A powerful, unified chat reader for **Twitch, TikTok, and Kick** built specifically for streamers. It combines all chats into a single, beautiful web interface and provides a customizable transparent overlay for OBS Studio.

It features built-in Twitch moderation tools (pinning messages, timeout/ban, deleting messages, checking banned lists, and creating clips), all powered by Twitch's modern OAuth Implicit Grant flow so you never have to manually generate and paste access tokens.

## 🚀 Features
- **Unified Chat:** Read Twitch, TikTok, and Kick chats all in one place.
- **OBS Overlay:** A transparent `/obs.html` page that natively integrates into your OBS scenes with slick animations.
- **Twitch Moderation:** Native UI for pinning messages (mimicking Twitch's exact UI), deleting messages, timing out/banning users, and clipping.
- **Easy Authentication:** 1-click Twitch Authorization popup to securely grant your own app permissions on the fly.
- **Dynamic Emotes & Badges:** Automatically fetches your channel's custom emotes and Twitch global badges.

---

## 🛠️ Setup Instructions (Local / Desktop)

### 1. Prerequisites
- Download and install [Node.js](https://nodejs.org/) (v16 or higher).
- A Twitch account.

### 2. Create a Twitch Developer Application
To interact with Twitch Chat and moderation, you need your own Twitch Client ID.
1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and log in.
2. Click **Register Your Application** (or **Add New App**).
3. Set the **Name** to whatever you want (e.g., "My Chat Reader").
4. **Important:** Add the following **OAuth Redirect URL**:
   - `http://localhost:8081/twitch-callback.html`
5. Set the **Category** to `Chat Bot` or `Broadcaster Utility`.
6. Click **Create**, then click **Manage** on your new app to copy your **Client ID**.

### 3. Install and Configure
1. Download or clone this repository to your computer.
2. Open a terminal (Command Prompt / PowerShell) in the folder.
3. Run `npm install` to install all required dependencies.
4. Create a new file named `.env` in the root folder.
5. Paste your Twitch Client ID into the `.env` file like this:
   ```env
   TWITCH_CLIENT_ID=your_client_id_here
   ```

### 4. Run the App
1. In your terminal, run `npm run dev` (or `node server.js`).
2. Open your web browser and go to: `http://localhost:8081`
3. Enter your Twitch channel name and click **Connect**.
4. The first time you connect, a **"Authorize Twitch 🔑"** button will appear. Click it, log into Twitch, and authorize your app. 
   *(This securely generates a token and saves it behind the scenes so you can moderate and chat!)*

### 5. OBS Setup
1. In OBS Studio, add a new **Browser Source**.
2. Set the URL to: `http://localhost:8081/obs.html`
3. Check the box that says **"Refresh browser when scene becomes active"**.
4. The chat overlay will now appear seamlessly on your stream!

---

## ☁️ Deploying to Render (Optional)

If you want to host this on the cloud so you don't have to run it on your PC:
1. Push this project to your GitHub.
2. Go to [Render](https://render.com/) and create a new **Web Service**.
3. Connect your GitHub repository.
4. Set the **Start Command** to: `node server.js`
5. Under **Environment Variables**, add:
   - Key: `TWITCH_CLIENT_ID`
   - Value: `your_client_id_here`
6. Go back to your Twitch Developer Console and add a second **OAuth Redirect URL** matching your Render domain:
   - `https://your-app-name.onrender.com/twitch-callback.html`
7. Deploy! Your app will automatically detect it's on Render and use the correct callback.

*(Note: Because Render's free tier sleeps and wipes temporary files, you will need to click "Authorize Twitch" whenever the app wakes up from sleep to restore your moderation token).*
