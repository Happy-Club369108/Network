// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.IO with CORS enabled
const io = new Server(server, { cors: { origin: "*" } });

// ---------------- Middleware ----------------
app.use(cors());
app.use(express.json());

// ---------------- MongoDB Connection ----------------
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/miniMALL";
mongoose
  .connect(MONGO_URL)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB Error:", err));

// ---------------- Schemas ----------------
const userSchema = new mongoose.Schema({
  avatar: String,
  name: String,
  number: { type: String },
  password: String,
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
});

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  text: String,
  seen: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);
const Message = mongoose.model("Message", messageSchema);

// ---------------- Routes ----------------

// Signup
app.post("/signup", async (req, res) => {
  try {
    const { name, number, password } = req.body;
    if (!name || !number || !password)
      return res.status(400).json({ message: "All fields required" });

    const exist = await User.findOne({ number });
    if (exist) return res.status(400).json({ message: "Number already exists" });

    const hash = await bcrypt.hash(password, 10);
    const newUser = await new User({ name, number, password: hash }).save();
    res.json({ userId: newUser._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { number, password } = req.body;
    const user = await User.findOne({ number });
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "Wrong password" });

    res.json({ userId: user._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get profile
app.get("/profile/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Search contacts
app.get("/search/:userId/:query", async (req, res) => {
  const { userId, query } = req.params;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const contacts = await User.find({
      _id: { $ne: userId, $nin: user.contacts },
      number: { $regex: query, $options: "i" },
    });
    res.json(contacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Add friend
app.post("/friends/:userId/:friendId", async (req, res) => {
  const { userId, friendId } = req.params;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.contacts.includes(friendId)) {
      user.contacts.push(friendId);
      await user.save();
    }
    res.json({ message: "Friend added" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get contacts
app.get("/contacts/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).populate(
      "contacts",
      "name avatar number"
    );
    res.json(user.contacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get messages
app.get("/messages/:userId/:contactId", async (req, res) => {
  try {
    const { userId, contactId } = req.params;
    const messages = await Message.find({
      $or: [
        { sender: userId, receiver: contactId },
        { sender: contactId, receiver: userId },
      ],
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------- Socket.IO ----------------
const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join", (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log(`User ${userId} joined. Online users:`, [...onlineUsers.keys()]);
  });

  socket.on("sendMessage", async ({ senderId, receiverId, text }) => {
    try {
      const message = await new Message({ sender: senderId, receiver: receiverId, text }).save();

      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit("receiveMessage", {
          _id: message._id,
          sender: senderId,
          receiver: receiverId,
          text,
          createdAt: message.createdAt,
        });
      }

      // Echo to sender
      socket.emit("receiveMessage", {
        _id: message._id,
        sender: senderId,
        receiver: receiverId,
        text,
        createdAt: message.createdAt,
      });
    } catch (err) {
      console.error("Message send error:", err);
    }
  });

  socket.on("callUser", ({ to, from, signalData, name, callType }) => {
    const calleeSocket = onlineUsers.get(to);
    if (calleeSocket) {
      io.to(calleeSocket).emit("incomingCall", { from, signalData, name, callType, online: true });
    } else {
      const callerSocket = onlineUsers.get(from);
      if (callerSocket) io.to(callerSocket).emit("calleeOffline", { to, name, callType });
    }
  });

  socket.on("answerCall", ({ to, signalData }) => {
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) io.to(callerSocket).emit("callAccepted", { signalData });
  });

  socket.on("rejectCall", ({ to }) => {
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) io.to(callerSocket).emit("callEnded", { reason: "Call rejected" });
  });

  socket.on("iceCandidate", ({ to, candidate }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) io.to(targetSocket).emit("iceCandidate", candidate);
  });

  socket.on("endCall", ({ to }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) io.to(targetSocket).emit("callEnded");
  });

  socket.on("disconnect", () => {
    for (const [userId, sockId] of onlineUsers.entries()) {
      if (sockId === socket.id) onlineUsers.delete(userId);
    }
    console.log("Socket disconnected:", socket.id);
  });
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
