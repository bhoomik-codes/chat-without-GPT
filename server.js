// server.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

// Import models
const User = require('./models/User');
const Message = require('./models/Message');
const Chat = require('./models/Chat');
const MessageRequest = require('./models/MessageRequest');
const Notification = require('./models/Notification');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat_app_db';
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretdefaultkey';

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4,
  retryReads: true,
  retryWrites: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/home.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Add a new route for the canvas app
app.get('/canvas.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'canvas.html'));
});

// Rate limiter for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per 15 minutes
  message:
    "Too many login attempts from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});

// API Endpoint for Authentication (Login/Register) with Validation
app.post(
  '/api/login',
  loginLimiter,
  [
    body('username')
      .trim()
      .isLength({ min: 3 })
      .withMessage('Username must be at least 3 characters long.')
      .isAlphanumeric()
      .withMessage('Username must be alphanumeric.'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long.')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,}$/)
      .withMessage('Password must include uppercase, lowercase, number, and special character.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { username, password } = req.body;

    try {
      let user = await User.findOne({ username });

      if (!user) {
        // If user does not exist, create a new one
        user = await User.create({ username, password });
        console.log(`New user registered: ${username}`);
      } else {
        // If user exists, validate password
        if (!user.password) {
          // This case should ideally not happen if all users are created with passwords
          console.warn(`User ${username} found but has no password stored. Treating as invalid credentials.`);
          return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
          console.log(`Failed login attempt for ${username}: Invalid password.`);
          return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }
      }

      // Generate JWT token
      const token = jwt.sign(
        { userId: user._id, username: user.username },
        JWT_SECRET,
        { expiresIn: '1h' } // Token expires in 1 hour
      );

      console.log(`User logged in via API: ${username}`);
      return res.status(200).json({ success: true, message: 'Login successful. Welcome back!', username: user.username, token });

    } catch (error) {
      console.error('Authentication API error:', error);
      if (error.code === 11000) {
        // Duplicate key error (username already exists)
        return res.status(409).json({ success: false, message: 'Username already taken. Please try a different one.' });
      }
      return res.status(500).json({ success: false, message: 'Authentication failed due to server error.' });
    }
  }
);

// Map to store socket IDs for each user ID
const userSocketMap = new Map(); // userId -> Set of socket.id

// Set to keep track of currently online users by username
const usersOnline = new Set();

// Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.log('Socket connection denied: No token provided.');
    return next(new Error('Authentication error: No token provided.'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    next(); // Proceed with connection
  } catch (error) {
    console.error('Socket connection denied: Invalid token.', error.message);
    return next(new Error('Authentication error: Invalid token.'));
  }
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id, 'Username:', socket.username);

  // Add user to online set and broadcast updated list
  usersOnline.add(socket.username);
  // Store socket ID for the user
  if (!userSocketMap.has(socket.userId)) {
    userSocketMap.set(socket.userId, new Set());
  }
  userSocketMap.get(socket.userId).add(socket.id);

  io.emit('activeUsers', [...usersOnline]);
  console.log(`${socket.username} connected to chat. Active users:`, [...usersOnline]);

  // Helper function to emit notifications to a specific user
  const emitNotificationToUser = async (userId, notificationData) => {
    const sockets = userSocketMap.get(userId);
    if (sockets) {
      for (const socketId of sockets) {
        io.to(socketId).emit('notification', notificationData);
      }
    }
    // Also save to DB for persistence and unread count
    await Notification.create({
      userId: userId,
      type: notificationData.type,
      message: notificationData.message,
      relatedEntity: notificationData.relatedEntity,
      relatedEntityType: notificationData.relatedEntityType
    });
  };

  // Request chat partners and active users
  socket.on('requestChatPartners', async () => {
    if (!socket.userId) {
      socket.emit('chatPartners', { success: false, message: 'User not authenticated.' });
      return;
    }

    try {
      const currentUserId = socket.userId;
      const currentUsername = socket.username;

      // 1. Get existing direct chats and groups
      const userChats = await Chat.find({ members: currentUserId })
        .populate('members', 'username')
        .sort({ updatedAt: -1 });

      const partners = [];
      const processedUserIds = new Set(); // To avoid duplicates for direct chats

      userChats.forEach(chat => {
        if (chat.isGroupChat) {
          // Add group chat
          partners.push({
            id: chat._id.toString(),
            username: chat.groupName,
            isGroup: true,
            status: 'chatting', // Always 'chatting' for active groups
            online: true // Groups are always "online"
          });
        } else if (chat.members.length === 2) {
          // Add direct chat partner
          const otherMember = chat.members.find(member => member._id.toString() !== currentUserId.toString());
          if (otherMember && !processedUserIds.has(otherMember._id.toString())) {
            partners.push({
              id: otherMember._id.toString(),
              username: otherMember.username,
              isGroup: false,
              status: 'chatting',
              online: usersOnline.has(otherMember.username)
            });
            processedUserIds.add(otherMember._id.toString());
          }
        }
      });

      // 2. Get pending message requests sent by current user
      const sentRequests = await MessageRequest.find({ sender: currentUserId, status: 'pending' })
        .populate('receiver', 'username');

      sentRequests.forEach(req => {
        if (!processedUserIds.has(req.receiver._id.toString())) {
          partners.push({
            id: req.receiver._id.toString(),
            username: req.receiver.username,
            isGroup: false,
            status: 'requestSent',
            requestId: req._id.toString(),
            online: usersOnline.has(req.receiver.username)
          });
          processedUserIds.add(req.receiver._id.toString());
        }
      });

      // 3. Get pending message requests received by current user
      const receivedRequests = await MessageRequest.find({ receiver: currentUserId, status: 'pending' })
        .populate('sender', 'username');

      receivedRequests.forEach(req => {
        if (!processedUserIds.has(req.sender._id.toString())) {
          partners.push({
            id: req.sender._id.toString(),
            username: req.sender.username,
            isGroup: false,
            status: 'requestReceived',
            requestId: req._id.toString(),
            online: usersOnline.has(req.sender.username)
          });
          processedUserIds.add(req.sender._id.toString());
        }
      });

      // 4. Get all other users (potential new contacts)
      const allUsers = await User.find({ _id: { $ne: currentUserId } });
      allUsers.forEach(user => {
        if (!processedUserIds.has(user._id.toString())) {
          partners.push({
            id: user._id.toString(),
            username: user.username,
            isGroup: false,
            status: 'none', // No existing chat or request
            online: usersOnline.has(user.username)
          });
          processedUserIds.add(user._id.toString());
        }
      });

      // Sort partners: active chats first, then requests, then others, then alphabetically
      partners.sort((a, b) => {
        const statusOrder = { 'chatting': 1, 'requestReceived': 2, 'requestSent': 3, 'none': 4 };
        if (statusOrder[a.status] !== statusOrder[b.status]) {
          return statusOrder[a.status] - statusOrder[b.status];
        }
        return a.username.localeCompare(b.username);
      });

      socket.emit('chatPartners', { success: true, partners: partners });
      console.log(`Chat partners sent for ${currentUsername}:`, partners.map(p => p.username));

      // Also send unread notification count
      const unreadCount = await Notification.countDocuments({ userId: currentUserId, isRead: false });
      socket.emit('unreadNotificationCount', unreadCount);

    } catch (error) {
      console.error('Error fetching chat partners:', error);
      socket.emit('chatPartners', { success: false, message: 'Failed to load chat partners.' });
    }
  });

  // Handle joining a chat room (direct or group)
  socket.on('joinRoom', async ({ targetName, isGroupChat }) => {
    if (!socket.userId) {
      console.warn('Attempt to join room without authenticated userId.');
      socket.emit('chatError', 'Authentication required to join chat.');
      return;
    }

    // Leave any previously joined chat rooms (excluding the user's private socket.id room)
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
        console.log(`${socket.username} left room: ${room}`);
      }
    });

    let targetChat = null;
    let chatNameForClient = targetName; // Default name to send back to client

    try {
      if (isGroupChat) {
        // Attempt to find an existing group chat
        targetChat = await Chat.findOne({
          isGroupChat: true,
          groupName: targetName,
          members: socket.userId // Ensure the user is a member of this group
        });

        if (!targetChat) {
          socket.emit('chatError', `Group chat "${targetName}" not found or you are not a member.`);
          return;
        }
      } else {
        // For direct chats, find the partner user first
        const partnerUser = await User.findOne({ username: targetName });

        if (!partnerUser) {
          socket.emit('chatError', `User "${targetName}" not found.`);
          return;
        }

        // Check for an existing direct chat between the two users
        targetChat = await Chat.findOne({
          isGroupChat: false,
          members: { $all: [socket.userId, partnerUser._id], $size: 2 }
        });

        // If no direct chat exists, check for pending message requests
        if (!targetChat) {
          const pendingRequest = await MessageRequest.findOne({
            $or: [
              { sender: socket.userId, receiver: partnerUser._id, status: 'pending' },
              { sender: partnerUser._id, receiver: socket.userId, status: 'pending' }
            ]
          });

          if (pendingRequest) {
            socket.emit('chatError', `Chat with ${targetName} cannot be started. A message request is pending.`);
            return;
          }

          // If no chat and no pending request, then it means they are not connected
          socket.emit('chatError', `You are not connected with ${targetName}. Send a message request first.`);
          return;
        }
      }

      if (targetChat) {
        const chatId = targetChat._id.toString();
        socket.join(chatId); // Join the socket.io room corresponding to the chat ID
        socket.currentChatId = chatId; // Store the current chat ID on the socket object
        console.log(`${socket.username} joined chat room: ${chatId} (${chatNameForClient})`);
        socket.emit('roomJoined', { chatId: chatId, chatName: chatNameForClient });
      } else {
        // This case should ideally be caught by the specific checks above
        socket.emit('chatError', 'Could not establish chat. An unexpected error occurred.');
      }

    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('chatError', 'Failed to join chat due to a server error.');
    }
  });

  // Handle leaving a chat room
  socket.on('leaveRoom', (chatId) => {
    socket.leave(chatId);
    socket.currentChatId = null; // Clear current chat ID on socket
    console.log(`${socket.username} left room: ${chatId}`);
  });

  // Handle new messages sent to a room
  socket.on("roomMessage", async ({ chatId, message }) => {
    // Validate message content
    if (!message || typeof message !== 'string' || message.trim().length === 0 || message.length > 500) {
        socket.emit("messageError", "Message content is invalid or too long (max 500 chars).");
        return;
    }

    const senderName = socket.username;
    const senderId = socket.userId;

    if (!senderId || !chatId) {
      console.warn('Attempt to send message without senderId or chatId.');
      socket.emit("messageError", "Authentication or chat context missing.");
      return;
    }

    try {
      // Create and save the new message
      const newMessage = await Message.create({
        content: message,
        chatId: chatId,
        sender: senderId,
        readBy: [senderId] // Mark message as read by sender initially
      });

      // Update the lastMessage and updatedAt fields of the chat
      await Chat.findByIdAndUpdate(chatId, { lastMessage: newMessage._id, updatedAt: new Date() });

      // Emit the message to all clients in the chat room
      socket.to(chatId).emit("roomMessage", {
        sender: senderName,
        message,
        timestamp: newMessage.createdAt,
        messageId: newMessage._id.toString()
      });
      console.log(`Message sent to chat ${chatId} by ${senderName}: ${message}`);

      // Notify other members of the chat about the new message if they are online
      const chat = await Chat.findById(chatId).populate('members', 'username');
      if (chat) {
        for (const member of chat.members) {
          if (member._id.toString() !== senderId.toString()) {
            const notificationMessage = chat.isGroupChat
              ? `${senderName} sent a message in ${chat.groupName}`
              : `${senderName} sent you a message`;
            await emitNotificationToUser(member._id, {
              type: 'newChatMessage',
              message: notificationMessage,
              relatedEntity: chatId,
              relatedEntityType: 'Chat'
            });
          }
        }
      }

    } catch (error) {
      console.error("Error saving message:", error);
      socket.emit("messageError", "Failed to send message.");
    }
  });

  // Load chat history for a given chat ID
  socket.on("loadChat", async (chatId) => {
    if (!chatId) {
      console.warn('Attempt to load chat history without chatId.');
      socket.emit("chatHistoryError", "Chat ID missing.");
      return;
    }

    try {
      // Find messages for the given chat ID, populate sender info, and sort by creation time
      const messages = await Message.find({ chatId: chatId })
        .populate('sender', 'username')
        .sort({ createdAt: 1 });

      // Map messages to a client-friendly format
      const history = messages.map(msg => ({
        sender: msg.sender ? msg.sender.username : 'Unknown',
        message: msg.content,
        timestamp: msg.createdAt,
        messageId: msg._id.toString()
      }));

      socket.emit("chatHistory", history);
      console.log(`Chat history loaded for chat ${chatId}`);

      // Mark messages as read by the current user
      await Message.updateMany(
        { chatId: chatId, readBy: { $ne: socket.userId } }, // Find messages in this chat not yet read by this user
        { $addToSet: { readBy: socket.userId } } // Add current user's ID to readBy array
      );

    } catch (error) {
      console.error("Error loading chat history:", error);
      socket.emit("chatHistoryError", "Failed to load chat history.");
    }
  });

  // Handle live typing indicators
  socket.on("liveTyping", ({ chatId, text, sender }) => {
    // Truncate text if too long to prevent excessive data transfer
    if (text && typeof text === 'string' && text.length > 100) {
        text = text.substring(0, 100) + '...';
    }

    // Emit typing indicator to others in the same chat room
    if (chatId) {
      socket.to(chatId).emit("showLiveTyping", {
        text,
        sender
      });
    }
  });

  // --- Message Request Feature ---
  socket.on('sendRequest', async ({ targetUsername }) => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to send request.');
      return;
    }
    if (targetUsername === socket.username) {
      socket.emit('chatError', 'Cannot send message request to yourself.');
      return;
    }

    try {
      const receiverUser = await User.findOne({ username: targetUsername });
      if (!receiverUser) {
        socket.emit('chatError', `User "${targetUsername}" not found.`);
        return;
      }

      // Check if a request already exists (pending, accepted, or rejected)
      const existingRequest = await MessageRequest.findOne({
        $or: [
          { sender: socket.userId, receiver: receiverUser._id },
          { sender: receiverUser._id, receiver: socket.userId }
        ]
      });

      if (existingRequest) {
        if (existingRequest.status === 'pending') {
          socket.emit('chatError', `A message request with ${targetUsername} is already pending.`);
        } else if (existingRequest.status === 'accepted') {
          socket.emit('chatError', `You are already connected with ${targetUsername}.`);
        } else { // rejected or canceled
          socket.emit('chatError', `A past request with ${targetUsername} was ${existingRequest.status}.`);
        }
        return;
      }

      // Create new message request
      const newRequest = await MessageRequest.create({
        sender: socket.userId,
        receiver: receiverUser._id,
        status: 'pending'
      });

      // Create notification for the receiver
      const notificationMessage = `${socket.username} sent you a message request.`;
      await emitNotificationToUser(receiverUser._id, {
        type: 'messageRequest',
        message: notificationMessage,
        relatedEntity: newRequest._id,
        relatedEntityType: 'MessageRequest'
      });

      socket.emit('requestSentStatus', { success: true, message: `Request sent to ${targetUsername}.` });
      console.log(`Message request sent from ${socket.username} to ${targetUsername}`);

      // Notify both sender and receiver to update their partner lists
      socket.emit('partnerListShouldUpdate'); // For sender
      const receiverSockets = userSocketMap.get(receiverUser._id.toString());
      if (receiverSockets) {
        for (const sockId of receiverSockets) {
          io.to(sockId).emit('partnerListShouldUpdate'); // For receiver
        }
      }

    } catch (error) {
      console.error('Error sending message request:', error);
      socket.emit('chatError', 'Failed to send message request.');
    }
  });

  socket.on('acceptRequest', async ({ requestId }) => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to accept request.');
      return;
    }

    try {
      const request = await MessageRequest.findById(requestId);

      if (!request || request.receiver.toString() !== socket.userId.toString() || request.status !== 'pending') {
        socket.emit('chatError', 'Invalid or expired message request.');
        return;
      }

      // Update request status
      request.status = 'accepted';
      await request.save();

      // Find or create a direct chat
      let chat = await Chat.findOne({
        isGroupChat: false,
        members: { $all: [request.sender, request.receiver], $size: 2 }
      });

      if (!chat) {
        chat = await Chat.create({
          members: [request.sender, request.receiver],
          isGroupChat: false
        });
        console.log(`New chat created between ${socket.username} and some user`);
      }

      // Create notification for the sender of the request
      const senderUser = await User.findById(request.sender);
      if (senderUser) {
        const notificationMessage = `${socket.username} accepted your message request.`;
        await emitNotificationToUser(senderUser._id, {
          type: 'requestAccepted',
          message: notificationMessage,
          relatedEntity: chat._id,
          relatedEntityType: 'Chat'
        });
      }

      socket.emit('requestAcceptedStatus', { success: true, message: 'Request accepted.', chatId: chat._id.toString() });
      console.log(`Message request ${requestId} accepted by ${socket.username}`);

      // Notify both users to update their partner lists
      socket.emit('partnerListShouldUpdate'); // For receiver (who accepted)
      const senderSockets = userSocketMap.get(request.sender.toString());
      if (senderSockets) {
        for (const sockId of senderSockets) {
          io.to(sockId).emit('partnerListShouldUpdate'); // For original sender
        }
      }

    } catch (error) {
      console.error('Error accepting message request:', error);
      socket.emit('chatError', 'Failed to accept message request.');
    }
  });

  socket.on('rejectRequest', async ({ requestId }) => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to reject request.');
      return;
    }

    try {
      const request = await MessageRequest.findById(requestId);

      if (!request || request.receiver.toString() !== socket.userId.toString() || request.status !== 'pending') {
        socket.emit('chatError', 'Invalid or expired message request.');
        return;
      }

      // Update request status
      request.status = 'rejected';
      await request.save();

      // Create notification for the sender of the request
      const senderUser = await User.findById(request.sender);
      if (senderUser) {
        const notificationMessage = `${socket.username} rejected your message request.`;
        await emitNotificationToUser(senderUser._id, {
          type: 'requestRejected',
          message: notificationMessage,
          relatedEntity: requestId,
          relatedEntityType: 'MessageRequest'
        });
      }

      socket.emit('requestRejectedStatus', { success: true, message: 'Request rejected.' });
      console.log(`Message request ${requestId} rejected by ${socket.username}`);

      // Notify both users to update their partner lists
      socket.emit('partnerListShouldUpdate'); // For receiver (who rejected)
      const senderSockets = userSocketMap.get(request.sender.toString());
      if (senderSockets) {
        for (const sockId of senderSockets) {
          io.to(sockId).emit('partnerListShouldUpdate'); // For original sender
        }
      }

    } catch (error) {
      console.error('Error rejecting message request:', error);
      socket.emit('chatError', 'Failed to reject message request.');
    }
  });

  socket.on('getNotifications', async () => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to get notifications.');
      return;
    }
    try {
      const notifications = await Notification.find({ userId: socket.userId })
        .sort({ createdAt: -1 }); // Most recent first
      socket.emit('notificationsList', { success: true, notifications: notifications });
    } catch (error) {
      console.error('Error fetching notifications:', error);
      socket.emit('notificationsList', { success: false, message: 'Failed to load notifications.' });
    }
  });

  socket.on('markNotificationAsRead', async ({ notificationId }) => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to mark notification as read.');
      return;
    }
    try {
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, userId: socket.userId },
        { isRead: true },
        { new: true }
      );
      if (notification) {
        socket.emit('notificationMarkedRead', { success: true, notificationId: notificationId });
        // Update unread count
        const unreadCount = await Notification.countDocuments({ userId: socket.userId, isRead: false });
        socket.emit('unreadNotificationCount', unreadCount);
      } else {
        socket.emit('chatError', 'Notification not found or unauthorized.');
      }
    } catch (error) {
      console.error('Error marking notification as read:', error);
      socket.emit('chatError', 'Failed to mark notification as read.');
    }
  });

  // --- Group Chat Feature ---
  socket.on('createGroup', async ({ groupName, memberUsernames }) => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to create a group.');
      return;
    }
    if (!groupName || groupName.trim().length < 3) {
      socket.emit('chatError', 'Group name must be at least 3 characters long.');
      return;
    }
    if (!memberUsernames || !Array.isArray(memberUsernames) || memberUsernames.length === 0) {
      socket.emit('chatError', 'Please select at least one member for the group.');
      return;
    }

    try {
      // Ensure the creator is also a member
      if (!memberUsernames.includes(socket.username)) {
        memberUsernames.push(socket.username);
      }

      // Find all member User IDs
      const memberUsers = await User.find({ username: { $in: memberUsernames } });
      const memberIds = memberUsers.map(user => user._id);

      if (memberIds.length !== memberUsernames.length) {
        socket.emit('chatError', 'One or more selected users were not found.');
        return;
      }

      // Check if a group with this name already exists
      const existingGroup = await Chat.findOne({ isGroupChat: true, groupName: groupName });
      if (existingGroup) {
        socket.emit('chatError', `A group with the name "${groupName}" already exists.`);
        return;
      }

      const newGroupChat = await Chat.create({
        members: memberIds,
        isGroupChat: true,
        groupName: groupName
      });

      console.log(`New group "${groupName}" created by ${socket.username}`);

      // Notify all members of the new group
      for (const memberId of memberIds) {
        const memberUser = memberUsers.find(u => u._id.toString() === memberId.toString());
        if (memberUser) {
          const notificationMessage = `${socket.username} added you to the group "${groupName}".`;
          await emitNotificationToUser(memberId, {
            type: 'groupCreated',
            message: notificationMessage,
            relatedEntity: newGroupChat._id,
            relatedEntityType: 'Chat'
          });
          // Re-emit chat partners to all members so they see the new group
          const memberSockets = userSocketMap.get(memberId.toString());
          if (memberSockets) {
            for (const sockId of memberSockets) {
              io.to(sockId).emit('partnerListShouldUpdate');
            }
          }
        }
      }

      socket.emit('groupCreatedSuccess', { success: true, message: `Group "${groupName}" created successfully!`, groupId: newGroupChat._id.toString(), groupName: groupName });

    } catch (error) {
      console.error('Error creating group:', error);
      socket.emit('chatError', 'Failed to create group due to a server error.');
    }
  });

  // New event to request all users for group creation checklist
  socket.on('requestAllUsers', async () => {
    if (!socket.userId) {
      socket.emit('allUsersList', { success: false, message: 'Authentication required.' });
      return;
    }
    try {
      // Fetch all users except the current one
      const allUsers = await User.find({ _id: { $ne: socket.userId } }).select('username');
      socket.emit('allUsersList', { success: true, users: allUsers.map(u => ({ id: u._id, username: u.username })) });
    } catch (error) {
      console.error('Error fetching all users:', error);
      socket.emit('allUsersList', { success: false, message: 'Failed to load users.' });
    }
  });

  // --- Canvas Integration ---
  socket.on('startCanvasSession', async ({ chatId, initiatorUsername, chatName }) => {
    if (!socket.userId) {
      socket.emit('chatError', 'Authentication required to start a canvas session.');
      return;
    }

    try {
      const chat = await Chat.findById(chatId).populate('members', 'username');
      if (!chat) {
        socket.emit('chatError', 'Chat not found for canvas session.');
        return;
      }

      // Construct a special message to invite others to the canvas
      // The format "CANVAS_INVITE:senderUsername:roomId:chatName" will be parsed by the client
      const canvasInviteMessageContent = `CANVAS_INVITE:${initiatorUsername}:${chatId}:${chatName}`;

      // Save this message to the chat history
      const newMessage = await Message.create({
        content: canvasInviteMessageContent,
        chatId: chatId,
        sender: socket.userId, // The initiator is the sender
        readBy: [socket.userId]
      });

      // Update the lastMessage and updatedAt fields of the chat
      await Chat.findByIdAndUpdate(chatId, { lastMessage: newMessage._id, updatedAt: new Date() });


      // Emit this special message to all clients in the chat room (including initiator to see it in their chatbox)
      io.to(chatId).emit("roomMessage", {
        sender: initiatorUsername, // Display the initiator as the sender
        message: canvasInviteMessageContent,
        timestamp: newMessage.createdAt,
        messageId: newMessage._id.toString()
      });

      console.log(`Canvas session initiated for chat ${chatId} by ${initiatorUsername}`);

      // Optionally, notify other members via their notification panel
      for (const member of chat.members) {
        if (member._id.toString() !== socket.userId.toString()) { // Don't notify the initiator again
          const notificationMessage = `${initiatorUsername} started a collaborative canvas in "${chatName}".`;
          await emitNotificationToUser(member._id, {
            type: 'canvasInvite',
            message: notificationMessage,
            relatedEntity: chatId,
            relatedEntityType: 'Chat'
          });
        }
      }

    } catch (error) {
      console.error('Error starting canvas session:', error);
      socket.emit('chatError', 'Failed to start canvas session.');
    }
  });


  // Handle client disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (socket.userId) {
      const userSockets = userSocketMap.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          usersOnline.delete(socket.username);
          userSocketMap.delete(socket.userId); // Remove user from map if no active sockets
          io.emit('activeUsers', [...usersOnline]);
          console.log(`${socket.username} disconnected. Active users:`, [...usersOnline]);
          // Re-emit chat partners to all remaining online users to update their online status
          io.emit('partnerListShouldUpdate');
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
