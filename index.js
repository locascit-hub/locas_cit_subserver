// index.js
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import webpush from "web-push";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import archiver from "archiver";
import zip from "express-zip";

dotenv.config();

// Recreate __dirname in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Express setup
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;

// serve static logs folder
const LOCAL_FOLDER = "buses";
const TMP_FOLDER = "tmp";
app.use(express.static(path.join(__dirname, LOCAL_FOLDER)));

// -------------------- Globals --------------------
let buses = []; // active bus list

// -------------------- VAPID --------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("❌ Missing VAPID keys in .env");
}

webpush.setVapidDetails(
  `mailto:${process.env.EMAIL || "noreply@example.com"}`,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// -------------------- Supabase --------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// -------------------- Local DB --------------------
const db = new Database("students.db");

// -------------------- DB Helpers --------------------
function wipeOutAndCreateDB() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription TEXT NOT NULL,
        clgNo TEXT NOT NULL,
        lat REAL,
        lon REAL,
        sent INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_clg_sent ON Students(clgNo, sent);
    `);
    db.exec("DELETE FROM Students; DELETE FROM sqlite_sequence WHERE name='Students';");
    console.log("Database wiped out and ready!");
  } catch (err) {
    console.error("DB error:", err);
  }
}

async function populateStudents() {
  try {
    const { data, error } = await supabase
      .from("Students")
      .select("subscription, clgNo, coordinates")
      .not("subscription", "is", null)
      .not("clgNo", "is", null);

    if (error) {
      console.error("Supabase error:", error);
      return;
    }

    if (!Array.isArray(data) || data.length === 0) {
      console.log("No students returned from Supabase.");
      return;
    }

    const insert = db.prepare(
      "INSERT INTO Students (subscription, clgNo, lat, lon) VALUES (?, ?, ?, ?)"
    );

    const insertMany = db.transaction((students) => {
      for (const s of students) {
        try {
          const subscription = s.subscription;
          const coords = (s.coordinates || "").split(",").map(parseFloat);
          if (coords.length !== 2 || Number.isNaN(coords[0]) || Number.isNaN(coords[1])) continue;
          const [lat, lon] = coords;
          insert.run(subscription, s.clgNo, lat, lon);
        } catch (inner) {
          console.error("Insert error for a student:", inner);
        }
      }
    });

    insertMany(data);
    console.log(`Inserted ${data.length} students into SQLite DB`);
  } catch (err) {
    console.error("populateStudents error:", err);
  }
}

// -------------------- Utilities --------------------
function recreateLogsFolder() {
  try {
    if (fs.existsSync(LOCAL_FOLDER)) fs.rmSync(LOCAL_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(LOCAL_FOLDER, { recursive: true });
    console.log("Logs folder ready!");
  } catch (err) {
    console.error("Error managing logs folder:", err);
  }
}

function getBoundingBox(lat, lon, kmRadius) {
  const R = 6371;
  const deltaLat = (kmRadius / R) * (180 / Math.PI);
  const deltaLon = (kmRadius / R) * (180 / Math.PI) / Math.cos(lat * Math.PI / 180);
  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLon: lon - deltaLon,
    maxLon: lon + deltaLon
  };
}

// -------------------- Push util --------------------
async function sendPush(students, payload, byFunc, bNo) {
  let successCount = 0;
  let failCount = 0;

  await Promise.allSettled(
    students.map(async (student) => {
      try {
        const subscription = JSON.parse(student.subscription);
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        successCount++;
      } catch (err) {
        failCount++;
      }
    })
  );

  console.log(`✅ Push finished for "${byFunc}-${bNo}" → ${successCount},${failCount}`);
  return { successCount, failCount };
}

// -------------------- Init --------------------
recreateLogsFolder();
wipeOutAndCreateDB();
populateStudents();

// -------------------- Routes --------------------

// Health check
app.get("/hey", (req, res) => res.send("hey"));

// Timer ready
let stopcount = 0;
let timer;
let counter = 0;

app.get("/getready", (req, res) => {
  const { sc } = req.query;
  stopcount = sc ? parseInt(sc, 10) || 12 : 12;
  res.send(`Timer set to ${stopcount}`);
});

// Admin actions
app.get("/actions", (req, res) => {
  const { task } = req.query;
  if (task === "resetdb") {
    wipeOutAndCreateDB();
    populateStudents();
    return res.send("Database reset and populated");
  } else if (task === "resetlogs") {
    recreateLogsFolder();
    return res.send("Logs folder recreated");
  } else return res.send("No valid action specified");
});

// -------------------- Bus updates (HTTP instead of WS) --------------------

// Simple DB lock to prevent concurrent writes
let dbLock = false;
async function acquireDbLock() { while (dbLock) await new Promise(r => setTimeout(r, 5)); dbLock = true; }
function releaseDbLock() { dbLock = false; }

app.post("/updatebus", async (req, res) => {
  const { busNo, event, lat, long } = req.body;
  if (!busNo || !event) return res.status(400).send("Missing busNo or event");

  console.log(`Update from bus ${busNo}: ${event} ${lat || ""} ${long || ""}`);


  try {
    await acquireDbLock();

    if (event === "bus_started") {
      const students = db.prepare("SELECT * FROM Students WHERE clgNo = ?").all(`${busNo}.0`);
      const pushData = { title: `Bus ${busNo} has started !!`, data: { busNo, ts: Date.now() } };
      if (students.length) await sendPush(students, pushData, "busstarted", busNo);
      buses.push(busNo);
    } else if (event === "bus_stopped") {
      buses = buses.filter(b => b !== busNo);
    } else if (event === "new_loc") {
      fs.appendFileSync(path.join(LOCAL_FOLDER, `logs_${busNo}.txt`), `${lat},${long}\n`);

      const box = getBoundingBox(lat, long, 1); // 1km radius
      const candidates = db.prepare(
        `SELECT id, subscription FROM Students WHERE clgNo = ? AND sent = 0
         AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
      ).all(`${busNo}.0`, box.minLat, box.maxLat, box.minLon, box.maxLon);

      const updateSent = db.prepare("UPDATE Students SET sent = 1 WHERE id = ?");

      if (candidates.length > 0) {
        await sendPush(candidates, { title: `Bus ${busNo} is nearby !!`, data: { busNo, ts: Date.now() } }, "nearby", busNo);
        for (const student of candidates) updateSent.run(student.id);
      }
    }

    releaseDbLock();
    res.send("Update received");
  } catch (err) {
    releaseDbLock();
    console.error("/updatebus error:", err);
    res.status(500).send("Server error");
  }
});

// -------------------- Nearby push --------------------
app.post("/nearbyfeature", async (req, res) => {
  try {
    const { bNo, lat, lon } = req.body;
    if (!bNo || lat == null || lon == null) return res.status(400).send("Missing bus number or coordinates");

    const box = getBoundingBox(lat, lon, 1); // 1 km radius
    const candidates = db.prepare(
      `SELECT id, subscription FROM Students
       WHERE clgNo = ? AND sent = 0
         AND lat BETWEEN ? AND ?
         AND lon BETWEEN ? AND ?`
    ).all(`${bNo}.0`, box.minLat, box.maxLat, box.minLon, box.maxLon);

    const updateSent = db.prepare("UPDATE Students SET sent = 1 WHERE id = ?");
    const pushData = { title: `Bus ${bNo} is nearby !!`, data: { bNo, ts: Date.now() } };

    if (candidates.length > 0) {
      await sendPush(candidates, pushData, "nearby", bNo);
      for (const student of candidates) updateSent.run(student.id);
    }

    fs.appendFileSync(path.join(LOCAL_FOLDER, `${bNo}_logs.txt`), `${lat},${lon}\n`);
    res.send("Nearby push triggered");
  } catch (err) {
    console.error("/nearbyfeature error:", err);
    res.status(500).send("Internal error");
  }
});

// -------------------- Export buses --------------------
const SERVER_NO = process.env.SUBSERVER_NO || "unknown";
const BUCKET_NAME = "Buses";
const supabaseStorage = createClient(
  process.env.SUPABASE_URL_STORAGE || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY_STORAGE || process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createZip(zipPath) {
  const files = fs.readdirSync(LOCAL_FOLDER);
  if (!files.length) throw new Error("No files to zip");

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    files.forEach(f => archive.file(path.join(LOCAL_FOLDER, f), { name: f }));
    archive.finalize();
  });
}

async function deleteIfExists(fileName) {
  try {
    const { data, error } = await supabaseStorage.storage.from(BUCKET_NAME).list("", { search: fileName });
    if (error) throw error;
    const existing = (data || []).find(f => f.name === fileName);
    if (existing) await supabaseStorage.storage.from(BUCKET_NAME).remove([fileName]);
  } catch (err) {
    console.error("deleteIfExists error:", err);
  }
}

app.get("/exportbuses", async (req, res) => {
  try {
    const dayStr = String(new Date().getDate()).padStart(2, "0");
    const zipFilename = `buses_logs_${SERVER_NO}_${dayStr}.zip`;

    fs.mkdirSync(TMP_FOLDER, { recursive: true });
    const zipPath = path.join(TMP_FOLDER, zipFilename);

    await createZip(zipPath);
    await deleteIfExists(zipFilename);

    const { error: uploadError } = await supabaseStorage.storage
      .from(BUCKET_NAME)
      .upload(zipFilename, fs.createReadStream(zipPath), { upsert: true, duplex: "half" });

    if (uploadError) throw uploadError;
    fs.unlinkSync(zipPath);
    res.send(`✅ Uploaded ${zipFilename} to Supabase Storage`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error uploading buses");
  }
});

app.get("/exportbuseszip", (req, res) => {
  try {
    const files = fs.readdirSync(LOCAL_FOLDER);
    const zipFiles = files.map(file => ({ path: path.join(LOCAL_FOLDER, file), name: file }));
    res.zip(zipFiles, `buses_logs_${SERVER_NO}.zip`);
  } catch (err) {
    console.error("exportbuseszip error:", err);
    res.status(500).send("Failed to create zip");
  }
});

// -------------------- Start Server --------------------
app.listen(port, () => console.log(`Server running on port ${port}`));



timer = setInterval(() => {
    fetch(`${process.env.URL}/hey`)
    .catch(err => console.error("Error in counter:", err));
     // time is greater than 8.10 am
    const now = new Date();

    if(counter>=stopcount || (now.getHours() === 8 && now.getMinutes() > 10)){
    clearInterval(timer);
    exportbuses();
    timer=null;
    counter=0;
    stopcount=0;
    buses = [];
    console.log(`Timer stopped after ${stopcount+1}`);
    return;
     }

    console.log("now-count", counter++, buses);

  }, 780000); // 13 minutes interval (780000 ms)

