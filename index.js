import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import webpush from "web-push";
import fs from "fs";

dotenv.config();

// Express setup
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;


let timer=null;
let url=process.env.URL||"";
let counter=0; //2hrs in 13 minutes frequency
let stopcount=0;


// VAPID keys
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  `mailto:${process.env.EMAIL}`, 
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// // Initialize single SQLite DB
const db = new Database("students.db");
//-----------------------////--------------------
//Create necessary folders

function recreateLogsFolder(){
  if (fs.existsSync("buses")){
  fs.rmSync("buses", { recursive: true, force: true });
console.log("Folder deleted!");
  fs.mkdirSync("buses");
  console.log("Folder created!");
}
else{
  fs.mkdirSync("buses");
  console.log("Folder created!");
}
}

function wipeOutAndCreateDB(){
  // Create Students table if not exists
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

//truncate all rows and reset id counter
db.exec("DELETE FROM Students; DELETE FROM sqlite_sequence WHERE name='Students';");
console.log("Database wiped out and ready!");
}

//-----------------------////--------------------



// Populate DB from Supabase (run once or periodically)
async function populateStudents() {
  const { data, error } = await supabase
    .from("Students")
    .select("subscription, clgNo, coordinates,id")
    .not("subscription", "is", null)
    .not("clgNo", "is", null);

  if (error) return console.error("Supabase error:", error);

  const insert = db.prepare(
    "INSERT INTO Students (subscription, clgNo, lat, lon) VALUES (?, ?, ?, ?)"
  );

  const insertMany = db.transaction((students) => {
    for (const s of students) {
      const subscription = s.subscription;
      const [lat, lon] = s.coordinates.split(",").map(parseFloat);
      //console.log(subscription, s.clgNo, lat, lon);
      insert.run(subscription, s.clgNo, lat, lon);
    }
  });


  insertMany(data);
  console.log(`Inserted ${data.length} students into single SQLite DB`);
}

recreateLogsFolder();
wipeOutAndCreateDB();
// Run once
populateStudents();

// Bounding box calculation
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

// ------------------- Common util -------------------
async function sendPush(students, payload,byFunc,bNo) {
  let successCount = 0;
  let failCount = 0;

  await Promise.allSettled(
    students.map(async (student) => {
      try {
        const subscription = JSON.parse(student.subscription);
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        successCount++;
      } catch (err) {
        console.error("Push failed:", err);
        failCount++;
      }
    })
  );

  console.log(
    `✅ Push finished for "${byFunc}-${bNo}" → ${successCount},${failCount}`
  );

  return { successCount, failCount };
}

app.get("/actions", (req, res) => {
  const {task}=req.query;
  if(task ==="resetdb"){
    wipeOutAndCreateDB();
    populateStudents();
    res.send("Database reset and populated");
  }
  else if(task==="resetlogs"){
    recreateLogsFolder();
    res.send("Logs folder recreated");
  }
  else{
    res.send("No valid action specified");
  }
});

// Nearby students
app.post("/nearbyfeature", async (req, res) => {
  const { bNo, lat, lon } = req.body;
  if (!bNo || lat == null || lon == null)
    return res.status(400).send("Missing bus number or coordinates");

  const box = getBoundingBox(lat, lon, 1); // 1 km radius
  console.log(lat,",",lon);
  const candidates = db.prepare(
    `SELECT id, subscription 
     FROM Students
     WHERE clgNo = ? AND sent = 0
       AND lat BETWEEN ? AND ?
       AND lon BETWEEN ? AND ?`
  ).all( `${bNo}.0`, box.minLat, box.maxLat, box.minLon, box.maxLon);

  const updateSent = db.prepare("UPDATE Students SET sent = 1 WHERE id = ?");

  const pushData = { title: `Bus ${bNo} is nearby !!`, data: {bNo:bNo,ts: Date.now()} };

  // Fire and forget (don't block API response)
  if(candidates.length>0){
  (async () => {
    try {
      await sendPush(candidates, pushData,"nearby",bNo);
      for (const student of candidates) updateSent.run(student.id);
    } catch (err) {
      console.error("Push loop error:", err);
    }
  })();
}

  fs.appendFileSync(`buses/${bNo}_logs.txt`, `${lat},${lon}\n`);
  res.send("Nearby push triggered");
});


// Bus started
app.get("/busstarted", async (req, res) => {
  const { bNo } = req.query;
  console.log("Bus started request for bus no:", bNo);
  if (!bNo) return res.status(400).send("Missing bus number");

  const students = db.prepare(
    "SELECT * FROM Students where clgNo = ?"
  ).all(`${bNo}.0`);

  // console.log(`Bus ${bNo} started with ${students.length} students`);

  const pushData = { title: `Bus ${bNo} has started !!`, data: {bNo:bNo,ts: Date.now()} };

  console.log(pushData);

  // Fire and forget
  if(students.length>0){
  (async () => {
    try {
      await sendPush(students, pushData,"busstarted",bNo);
    } catch (err) {
      console.error("Push loop error:", err);
    }
  })();
}

  res.send("Push triggered");
});


app.get("/hey",(req, res) => {
  res.send("hey");
});

app.get("/getready",(req, res) => {
  const {sc}=req.query;
  if(!sc){
  stopcount=9;
  }
  else{
    stopcount=parseInt(sc);
  }
  res.send(`Timer set to ${stopcount}`);
});


app.get("/stopcount",(req, res) => {
  if(timer){
    clearInterval(timer);
    timer=null;
    counter=0;
    stopcount=1;
    console.log("Timer stopped manually");
  }
  res.send("Timer stopped");
});



app.listen(port, () => console.log(`Server running on port ${port}`));

timer = setInterval(() => {
    fetch(`${url}/hey`)
    .catch(err => console.error("Error in counter:", err));

    if(counter>stopcount){
    clearInterval(timer);
    timer=null;
    counter=0;
    console.log(`Timer stopped after ${stopcount+1}`);
    return;
     }

    console.log("now-count", counter++);

  }, 780000); // 13 minutes interval (780000 ms)
