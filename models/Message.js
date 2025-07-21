// models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Changed from 'room' to 'chatId' to link directly to a Chat document
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  // Added for read receipts: an array of User IDs who have read this message
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

// Add an index on chatId for faster message retrieval for a specific chat
messageSchema.index({ chatId: 1 });
// Add an index on createdAt for efficient sorting of messages
messageSchema.index({ createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
