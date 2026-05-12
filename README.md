# Outerlands Recipe Builder

A kitchen management app for tracking ingredients, building recipes and dishes, calculating costs, and printing scaled recipe PDFs.

---

## What You Need Before Starting

- A **Google account** (for Firebase — it's free)
- A **GitHub account** (you already have this)
- A **Vercel account** (free — you'll create one using your GitHub login)
- **Node.js** installed on your computer (see below)

### Installing Node.js

Node.js is the tool that lets you run JavaScript projects on your computer. You only need to install it once.

1. Go to [https://nodejs.org](https://nodejs.org)
2. Download the **LTS** version (the one that says "Recommended for most users")
3. Run the installer — accept all the defaults
4. When it's done, open your **Terminal** (Mac) or **Command Prompt** (Windows) and type:
   ```
   node --version
   ```
   If you see a version number like `v20.11.0`, you're good.

---

## Step 1: Set Up Firebase (Your Database)

Firebase is where your app stores all ingredient, recipe, and dish data. It's a Google product with a free tier that's more than enough for this app.

### 1A. Create a Firebase Project

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **"Create a project"** (or "Add project")
3. Name it something like `outerlands-recipes`
4. It will ask about Google Analytics — you can turn this **off** (you don't need it)
5. Click **Create project**, then **Continue** when it's ready

### 1B. Create a Firestore Database

Firestore is the specific database within Firebase where your data lives.

1. In your Firebase project, click **"Build"** in the left sidebar, then **"Firestore Database"**
2. Click **"Create database"**
3. It will ask about location — pick the one closest to you (e.g., `us-west1` for San Francisco)
4. For security rules, select **"Start in test mode"** — this lets anyone with the URL read and write data. (We'll discuss locking this down later.)
5. Click **Enable**

### 1C. Get Your Firebase Config

1. In the Firebase console, click the **gear icon** (⚙️) next to "Project Overview" in the top-left
2. Click **"Project settings"**
3. Scroll down to **"Your apps"**. If there are no apps listed, click the **web icon** (`</>`)
4. Give the app a nickname like `recipe-builder` and click **Register app**
5. You'll see a code block that looks like this:
   ```javascript
   const firebaseConfig = {
     apiKey: "AIzaSyB...",
     authDomain: "outerlands-recipes.firebaseapp.com",
     projectId: "outerlands-recipes",
     storageBucket: "outerlands-recipes.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abc123"
   };
   ```
6. **Copy these values.** You'll paste them into the app in Step 3.

---

## Step 2: Push the Project to GitHub

GitHub stores your code and connects to Vercel for automatic deployment.

### 2A. Create a New Repository

1. Go to [https://github.com/new](https://github.com/new)
2. Name the repository `outerlands-recipe-builder`
3. Make sure it's set to **Private** (your Firebase config will be in here)
4. Do **NOT** check "Add a README file" (we already have one)
5. Click **Create repository**
6. You'll see a page with instructions — keep this tab open

### 2B. Upload the Project Files

The easiest way, since you're new to Git:

**Option A — Upload via the GitHub website (simplest):**

1. On the repository page, click **"uploading an existing file"** (it's in the blue quick setup box)
2. Drag the entire contents of the `outerlands-recipe-builder` folder into the upload area. Make sure you're dragging the files/folders INSIDE the project folder, not the folder itself. You should see: `src/`, `public/`, `package.json`, `vite.config.js`, `index.html`, `.gitignore`, `README.md`
3. Scroll down, type "Initial commit" in the commit message
4. Click **Commit changes**

**Option B — Using the terminal (if you want to learn Git):**

Open Terminal, navigate to the project folder, and run:
```bash
cd path/to/outerlands-recipe-builder
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/outerlands-recipe-builder.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 3: Add Your Firebase Config

1. On GitHub, navigate into the `src/` folder and click on `firebase.js`
2. Click the **pencil icon** (✏️) in the top right to edit the file
3. Replace the placeholder values with the real values you copied in Step 1C:
   ```javascript
   const firebaseConfig = {
     apiKey: "your-real-api-key",
     authDomain: "your-project-id.firebaseapp.com",
     projectId: "your-project-id",
     storageBucket: "your-project-id.appspot.com",
     messagingSenderId: "your-sender-id",
     appId: "your-app-id"
   };
   ```
4. Click **Commit changes** (green button)

**A note on the API key:** Firebase API keys are not secret in the traditional sense. They identify your project but don't grant access on their own — Firestore security rules control who can read/write. Keeping the repo private is still good practice, though.

---

## Step 4: Deploy on Vercel

Vercel takes your code from GitHub and puts it on the internet.

### 4A. Create a Vercel Account

1. Go to [https://vercel.com](https://vercel.com)
2. Click **"Sign Up"**
3. Choose **"Continue with GitHub"** — this links the two accounts

### 4B. Import Your Project

1. Once logged in, click **"Add New..."** → **"Project"**
2. You'll see your GitHub repositories listed. Find `outerlands-recipe-builder` and click **Import**
3. Vercel auto-detects that it's a Vite project. The default settings are correct:
   - **Framework Preset:** Vite
   - **Build Command:** `vite build`
   - **Output Directory:** `dist`
4. Click **Deploy**
5. Wait 1–2 minutes. When it's done, Vercel gives you a URL like:
   ```
   https://outerlands-recipe-builder.vercel.app
   ```

**That's it — your app is live.** Send that URL to your chefs.

### 4C. (Optional) Custom Domain

If you want something like `recipes.outerlandssf.com`:

1. In Vercel, go to your project → **Settings** → **Domains**
2. Type your desired domain and click **Add**
3. Vercel will show you DNS records to add at your domain registrar

---

## Step 5: Test It

1. Open the Vercel URL in your browser
2. Add a test ingredient
3. Open the same URL on a different device or in a private/incognito window
4. Verify the ingredient shows up on both — this confirms Firebase sync is working

---

## Day-to-Day Usage

### Making Changes to the App

If you ever want to update the app (through me or on your own):

1. Edit files on GitHub (directly in the browser, or push from your computer)
2. Vercel automatically detects the change and redeploys — takes about 1 minute
3. Your chefs see the updated app next time they refresh

### Your Data

All data lives in Firebase. You can view it directly:

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Open your project → **Firestore Database**
3. You'll see the `app` collection with your `kitchen-data` document containing all ingredients, recipes, and dishes

### Backing Up

To back up your data, use the **Export CSV** button in the Ingredients tab. For a full backup of everything (recipes and dishes too), you can copy the raw data from the Firebase console.

---

## Locking Down Access (Optional but Recommended)

Right now, anyone with the URL could technically read/write your data if they had your Firebase config. For a small team this is low-risk, but if you want to lock it down:

### Option A: Simple Domain Restriction

In the Firebase console:
1. Go to **Project Settings** → your web app
2. Under **"Authorized domains"**, add only your Vercel URL
3. This prevents the API key from being used on other websites

### Option B: Firestore Security Rules

In the Firebase console → **Firestore Database** → **Rules**, you can replace the default rules. For example, to require that the request comes from an authenticated user, you'd need to add Firebase Authentication (a bigger project, but doable as a next step).

For now, the test-mode rules are fine for a private restaurant tool.

---

## Running Locally (Optional)

If you want to test changes on your own computer before deploying:

```bash
cd outerlands-recipe-builder
npm install
npm run dev
```

This starts a local server at `http://localhost:5173`. Changes you make to the code appear instantly in the browser.

---

## Troubleshooting

**"Module not found" errors after cloning:**
Run `npm install` in the project folder.

**Data not showing up across devices:**
Check your Firebase config values in `src/firebase.js`. Make sure they match exactly what Firebase gave you.

**Vercel deploy failed:**
Click into the failed deployment on Vercel to see the error log. Common issues: typo in a file, missing comma in JSON, etc.

**Blank page after deploy:**
Open browser developer tools (F12 → Console tab) to see error messages. Usually a Firebase config issue.
