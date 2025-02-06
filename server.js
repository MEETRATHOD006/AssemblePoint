const express = require("express");
const app = express();
const server = require("http").Server(app);
const io = require("socket.io")(server);
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const { PeerServer } = require('peer'); 

const pool = new Pool({
  connectionString: 'postgresql://postgres.pezdqmellmcmewcvssbv:8594@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static("public"));

// Test DB connection
pool.connect()
  .then(() => console.log("Connected to PostgreSQL database"))
  .catch(err => {
    console.error("Database connection failed:", err.message);
    process.exit(1);
  });

// Set up storage for file uploads
const storage = multer.diskStorage({
    destination: "public/uploads/",
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage });

const rooms = {}; // Stores room data
const activeScreenShares = {}; // Global object to store active screen share per room

// Serve the landing page for the root URL
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// Create Room
app.post("/create_room", async (req, res) => {
  const { room_id, room_name, admin_name } = req.body;
  if (!room_id || !room_name || !admin_name) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO rooms (room_id, room_name, admin_name, participants) VALUES ($1, $2, $3, $4) RETURNING *",
      [room_id, room_name, admin_name, JSON.stringify([])]
    );

    res.status(200).json({ message: "Room created successfully" });
  } catch (err) {
    console.error("Failed to create room:", err.message);
    res.status(500).json({ error: "Failed to create room" });
  }
});

// Join Room
app.post("/join_room", async (req, res) => {
  const { room_id, participant_name } = req.body;
  
  if (!room_id || !participant_name) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  try {
    // Check if room exists
    const result = await pool.query("SELECT * FROM rooms WHERE room_id = $1", [room_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Update participants
    const room = result.rows[0];
    const participants = room.participants;
    participants.push(participant_name);
    
    await pool.query("UPDATE rooms SET participants = $1 WHERE room_id = $2", [
      JSON.stringify(participants),
      room_id,
    ]);
    console.log("pool query done");
    res.status(200).json({ message: "Joined room successfully" });
  } catch (err) {
    console.error("Error joining room:", err.message);
    res.status(500).json({ error: "Failed to join room" });
  }
});

// Fetch chat messages for a room
app.get("/messages/:room_id", async (req, res) => {
  const { room_id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM messages WHERE room_id = $1 ORDER BY timestamp ASC", [room_id]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Failed to fetch messages:", err.message);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Handle Room Routes
app.get("/:room", async (req, res) => {
  const roomId = req.params.room;

  try {
    const result = await pool.query("SELECT * FROM rooms WHERE room_id = $1", [roomId]);
    if (result.rowCount === 0) {
      return res.status(404).send("Room not found.");
    }
    
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } catch (err) {
    console.error("Failed to load room:", err.message);
    res.status(500).send("Internal server error.");
  }
});

// Handle photo upload
app.post("/upload-photo", upload.single("photo"), (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");
    res.json({ url: "/uploads/" + req.file.filename });
});

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("create_room", (data) => {
    console.log("Room created:", data.room_id);
    socket.join(data.room_id);
    rooms[data.room_id] = { videoId: null, currentTime: 0 };
  });

  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId);
    io.to(roomId).emit('user-connected', userId);
    console.log(`User ${userId} joined room ${roomId}`);

    if (activeScreenShares[roomId]) {
      socket.emit("active-screen-share", activeScreenShares[roomId]);
    }

    socket.on("disconnect", () => {
      io.to(roomId).emit('user-disconnected', userId)
      console.log("User disconnected:", socket.id);
    });
  });

  // Handle screen share start/stop
  socket.on("screen-share-start", (roomId, sharedUserId) => {
    console.log("Screen share started by:", sharedUserId);
    activeScreenShares[roomId] = sharedUserId; // Save active screen share info
    socket.to(roomId).emit("screen-share-started", sharedUserId);
  });
  
  socket.on("screen-share-stop", (roomId, sharedUserId) => {
    console.log("Screen share stopped by:", sharedUserId);
    delete activeScreenShares[roomId];
    socket.to(roomId).emit("screen-share-stopped", sharedUserId);
  });

  socket.on("active-screen-share", (roomId, myPeerId) => {
    let sharedUserId = myPeerId;
    io.to(roomId).emit("active-screen-shared", roomId, sharedUserId);
  })

  socket.on("mute-user", (roomId, myPeerId) => {
    let userPeerId = myPeerId;
    io.to(roomId).emit("user-muted", roomId, userPeerId);
  })

  socket.on("unmute-user", (roomId, myPeerId) => {
    let userPeerId = myPeerId;
    io.to(roomId).emit("user-unmuted", roomId, userPeerId); 
  })

  socket.on("camera-turn-off", (roomId, myPeerId) => {
    let userPeerId = myPeerId;
    io.to(roomId).emit("camera-turn-offed", roomId, userPeerId);
  })
  
  socket.on("camera-turn-on", (roomId, myPeerId) => {
    let userPeerId = myPeerId;
    io.to(roomId).emit("camera-turn-oned", roomId, userPeerId);
  })

  // Chat functionality
  socket.on("send-message", async ({ roomId, sender, message, myPeerId }) => {
    try {
      await pool.query("INSERT INTO messages (room_id, sender, message) VALUES ($1, $2, $3)", [roomId, sender, message]);
      console.log("server side:", myPeerId);
      let senderId = myPeerId;
      io.to(roomId).emit("receive-message", { sender, message, timestamp: new Date(), senderId });
    } catch (err) {
      console.error("Failed to save message:", err.message);
    }
  });

  socket.on("send-photo", async ({ roomId, sender, photoUrl, senderId, message }) => {
    try {
      // Save the photo message into the database
      await pool.query(
        "INSERT INTO messages (room_id, sender, message, photo_url) VALUES ($1, $2, $3, $4)",
        [roomId, sender, message, photoUrl]
      );
      // Broadcast the photo message to the room
      io.to(roomId).emit("receive-photo", { sender, photoUrl, timestamp: new Date(), senderId, message });
    } catch (err) {
      console.error("Failed to save photo message:", err.message);
    }
  });
  
});


server.listen(8000, () => console.log("Server running on port 8000"));
