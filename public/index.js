const authToken = localStorage.getItem("authToken");
const socket = io({
  auth: {
    token: authToken
  }
});

let username = "";
let currentChatId = "";
let currentChatPartnerOrGroupName = ""; // Stores the name of the current chat partner or group
let allUsersForGroupSelection = []; // To store all users for group creation checklist

const chatbox = document.getElementById("chatBox");
const input = document.getElementById("m");
const userList = document.getElementById("userList"); // This is now a <ul>
const userSearchInput = document.getElementById("userSearch");
const chatInterface = document.getElementById("chatInterface");
const chatWithHeader = document.getElementById("chat-with-header"); // Correctly target the h3
const logoutButton = document.getElementById("logoutButton");
const loggedInUsernameDisplay = document.getElementById('loggedInUsernameDisplay'); // New element for username display

// Notification UI elements
const notificationBell = document.getElementById('notificationBell');
const notificationCountSpan = document.getElementById('notificationCount');
const notificationPanel = document.getElementById('notificationPanel');
const notificationsListElem = document.getElementById('notificationsList');
const closeNotificationPanelBtn = document.getElementById('closeNotificationPanel');
const markAllReadBtn = document.getElementById('markAllReadBtn');

// Group Creation UI elements
const createGroupBtn = document.getElementById('createGroupBtn');
const groupCreationModal = document.getElementById('groupCreationModal');
const groupNameInput = document.getElementById('groupNameInput');
const groupMembersChecklist = document.getElementById('groupMembersChecklist');
const createGroupConfirmBtn = document.getElementById('createGroupConfirmBtn');
const cancelGroupCreationBtn = document.getElementById('cancelGroupCreationBtn');

// Canvas Integration elements
const startCanvasBtn = document.getElementById('startCanvasBtn');


// Create and append the live typing box once
const liveTypingBox = document.createElement("div");
liveTypingBox.id = "liveTypingBox";
liveTypingBox.style.fontStyle = "italic";
liveTypingBox.style.color = "#777";
liveTypingBox.style.padding = "5px 10px";
liveTypingBox.style.order = "999"; // Ensure it's always at the bottom of the chatbox
chatbox.appendChild(liveTypingBox);

window.onload = () => {
  username = localStorage.getItem("authenticatedUsername");
  const storedAuthToken = localStorage.getItem("authToken");

  if (username && storedAuthToken) {
    chatInterface.style.display = "flex";
    loggedInUsernameDisplay.textContent = `Logged in as: ${username}`; // Display username

    // Display welcome message
    appendMessage("System", `👋 Welcome, ${username}!`, new Date(), false); // false for isSelf (system message)

    // Request chat partners and initial notifications
    socket.emit("requestChatPartners");
    socket.emit("getNotifications");
  } else {
    // Redirect to login if not authenticated
    location.href = "/";
  }
};

// Event listener for user search input (Enter key)
userSearchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    const target = e.target.value.trim();
    if (target && target !== username) {
      // For search, assume direct message intent or request
      startChatWithUserOrGroup(target, false);
    }
    e.target.value = ""; // Clear search input
  }
});

// Event listener for clicks on user list items (since it's a <ul>)
userList.addEventListener("click", (e) => {
  const listItem = e.target.closest('li.user-item'); // Get the closest li with class user-item
  if (listItem) {
    // Handle actions based on the button clicked within the list item
    if (e.target.classList.contains('send-request-btn')) {
      const targetUsername = listItem.dataset.username;
      if (targetUsername) {
        socket.emit('sendRequest', { targetUsername });
      }
      return; // Stop further processing for button click
    }
    if (e.target.classList.contains('accept-request-btn')) {
      const requestId = e.target.dataset.requestId;
      if (requestId) {
        socket.emit('acceptRequest', { requestId });
      }
      return;
    }
    if (e.target.classList.contains('reject-request-btn')) {
      const requestId = e.target.dataset.requestId;
      if (requestId) {
        socket.emit('rejectRequest', { requestId });
      }
      return;
    }

    // If no button was clicked, assume it's a click to open chat
    // Remove 'active' class from all other items
    Array.from(userList.children).forEach(item => item.classList.remove('active'));
    // Add 'active' class to the clicked item
    listItem.classList.add('active');

    const selectedTarget = listItem.dataset.username; // Get username from data attribute
    const isGroup = listItem.dataset.isGroup === 'true'; // Get group status
    const status = listItem.dataset.status; // Get current status

    if (selectedTarget && selectedTarget !== username) {
      if (status === 'chatting' || isGroup) {
        startChatWithUserOrGroup(selectedTarget, isGroup);
      } else {
        // If not chatting, display a message or prompt to send request
        appendMessage("System", `You are not connected with ${selectedTarget}. Send a message request to start chatting.`, new Date(), false);
        chatWithHeader.textContent = `Connect with ${selectedTarget}`;
        currentChatId = ""; // Clear current chat ID
      }
    }
  }
});

// Event listener for message input (Enter key)
input.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    sendMessage();
  } else {
    emitLiveTyping();
  }
});

// Event listener for send button
document.getElementById("send").addEventListener("click", sendMessage);

// Event listener for logout button
logoutButton.addEventListener('click', () => {
  // Clear authentication data from localStorage
  localStorage.removeItem("authenticatedUsername");
  localStorage.removeItem("authToken");
  // Redirect to login page
  location.href = "/";
});

// --- Notification Panel Logic ---
notificationBell.addEventListener('click', () => {
  notificationPanel.classList.toggle('hidden'); // Use classList.toggle
  if (!notificationPanel.classList.contains('hidden')) { // Check if it's now visible
    socket.emit('getNotifications'); // Fetch notifications when panel opens
  }
});

closeNotificationPanelBtn.addEventListener('click', () => {
  notificationPanel.classList.add('hidden'); // Add 'hidden' class to hide
});

markAllReadBtn.addEventListener('click', () => {
  const notificationItems = notificationsListElem.querySelectorAll('li:not(.read)');
  notificationItems.forEach(item => {
    const notificationId = item.dataset.notificationId;
    if (notificationId) {
      socket.emit('markNotificationAsRead', { notificationId });
    }
  });
});

// --- Group Creation Logic ---
createGroupBtn.addEventListener('click', async () => {
  groupCreationModal.style.display = 'block'; // Show the modal (reverted to original behavior)
  groupNameInput.value = ''; // Clear previous input
  groupMembersChecklist.innerHTML = ''; // Clear previous checklist

  // Fetch all users to populate the checklist
  socket.emit('requestAllUsers');

  // Listener for all users (using .once to avoid multiple listeners)
  socket.once('allUsersList', ({ success, users }) => {
    if (success) {
      allUsersForGroupSelection = users.filter(user => user.username !== username); // Exclude current user
      allUsersForGroupSelection.forEach(user => {
        const li = document.createElement('li');
        li.innerHTML = `
          <input type="checkbox" id="user-${user.id}" value="${user.username}" data-userid="${user.id}">
          <label for="user-${user.id}">${user.username}</label>
        `;
        groupMembersChecklist.appendChild(li);
      });
      // No change to modal display here, as per user's request to revert
    } else {
      appendMessage("System", "Failed to load users for group creation.", new Date(), false);
    }
  });
});

cancelGroupCreationBtn.addEventListener('click', () => {
  groupCreationModal.style.display = "none"; // Hide the modal (reverted to original behavior)
});

createGroupConfirmBtn.addEventListener('click', () => {
  const groupName = groupNameInput.value.trim();
  const selectedMembers = Array.from(groupMembersChecklist.querySelectorAll('input[type="checkbox"]:checked'))
                               .map(checkbox => checkbox.value);

  if (!groupName) {
    appendMessage("System", "Please enter a group name.", new Date(), false);
    return;
  }
  if (selectedMembers.length === 0) {
    appendMessage("System", "Please select at least one member for the group.", new Date(), false);
    return;
  }

  socket.emit('createGroup', { groupName, memberUsernames: selectedMembers });
  groupCreationModal.style.display = "none"; // Hide the modal after sending request (reverted to original behavior)
});

// --- Canvas Integration Logic ---
startCanvasBtn.addEventListener('click', () => {
    if (!currentChatId) {
        appendMessage("System", "Please select a chat to start a collaborative canvas session.", new Date(), false);
        return;
    }
    if (!currentChatPartnerOrGroupName) {
        appendMessage("System", "Cannot start canvas without a chat partner or group name.", new Date(), false);
        return;
    }

    // Emit an event to the server to initiate a canvas session for this chat
    socket.emit('startCanvasSession', {
        chatId: currentChatId,
        initiatorUsername: username,
        chatName: currentChatPartnerOrGroupName
    });

    appendMessage("System", `You initiated a collaborative canvas session in "${currentChatPartnerOrGroupName}".`, new Date(), false);
});

// Listen for incoming canvas invitations
socket.on('canvasInvite', ({ senderUsername, roomId, chatName }) => {
    // Only show invite if it's for the currently active chat or a relevant chat
    if (roomId === currentChatId) {
        appendMessage("System", `${senderUsername} has invited you to a collaborative drawing session in "${chatName}".`, new Date(), false, 'canvasInvite', { roomId, senderUsername });
    } else {
        // Optionally, handle invites for other chats (e.g., show a notification)
        console.log(`Received canvas invite for another room: ${chatName} from ${senderUsername}`);
        // For now, we'll just append a system message, but you might want a more prominent notification
        appendMessage("System", `New canvas invite from ${senderUsername} for "${chatName}". Please navigate to that chat to accept.`, new Date(), false);
    }
});


/**
 * Initiates a chat with a specific user or group.
 * @param {string} targetName The username or group name to chat with.
 * @param {boolean} isGroupChat True if it's a group chat, false for direct.
 */
function startChatWithUserOrGroup(targetName, isGroupChat) {
  if (currentChatId) {
    socket.emit("leaveRoom", currentChatId); // Leave previous room if any
  }

  // Clear chatbox and re-append live typing box
  chatbox.innerHTML = "";
  chatbox.appendChild(liveTypingBox);
  liveTypingBox.textContent = ""; // Clear any previous typing indicator

  // Request to join the room (server will handle creating/finding chat and providing chatId)
  socket.emit("joinRoom", { targetName, isGroupChat });

  // Update header immediately
  chatWithHeader.textContent = `Chatting with ${targetName}`;
  currentChatPartnerOrGroupName = targetName; // Store for later reference
}

/**
 * Emits a live typing event to the server.
 */
function emitLiveTyping() {
  if (currentChatId) {
    socket.emit("liveTyping", {
      chatId: currentChatId,
      text: input.value,
      sender: username
    });
  }
}

/**
 * Sends a message to the current chat.
 */
function sendMessage() {
  const message = input.value.trim();
  if (currentChatId && message) {
    socket.emit("roomMessage", { chatId: currentChatId, message });

    // Display own message immediately in the chatbox
    appendMessage(username, message, new Date(), true); // true for isSelf
    chatbox.scrollTop = chatbox.scrollHeight; // Scroll to bottom

    input.value = ""; // Clear input field
    liveTypingBox.textContent = ""; // Clear typing indicator after sending
  } else if (!currentChatId) {
    appendMessage("System", "Please select a user or group to chat with.", new Date(), false);
  }
}

/**
 * Appends a message to the chatbox.
 * @param {string} sender The username of the sender.
 * @param {string} message The message content.
 * @param {string|Date} timestamp The timestamp of the message.
 * @param {boolean} isSelf True if the message is from the current user, false otherwise.
 * @param {string} [type] Optional type for special messages (e.g., 'canvasInvite').
 * @param {Object} [data] Optional data for special messages (e.g., { roomId, senderUsername }).
 */
function appendMessage(sender, message, timestamp, isSelf, type = null, data = null) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${isSelf ? 'self' : 'other'}`;

  const msgContent = document.createElement("div");
  msgContent.className = "message-content";

  const senderStrong = document.createElement("strong");
  senderStrong.textContent = isSelf ? "You" : sender;
  msgContent.appendChild(senderStrong);

  const messageText = document.createTextNode(message);
  msgContent.appendChild(messageText);

  // Handle special message types
  if (type === 'canvasInvite' && data) {
      const acceptCanvasBtn = document.createElement('button');
      acceptCanvasBtn.textContent = 'Accept Canvas';
      acceptCanvasBtn.className = 'btn-primary canvas-accept-btn'; // Add a class for styling
      acceptCanvasBtn.style.marginTop = '10px';
      acceptCanvasBtn.style.padding = '8px 15px';
      acceptCanvasBtn.style.borderRadius = '5px';
      acceptCanvasBtn.style.cursor = 'pointer';
      acceptCanvasBtn.style.backgroundColor = 'var(--accent)'; // Use theme accent color
      acceptCanvasBtn.style.color = 'var(--text-light)';
      acceptCanvasBtn.style.border = 'none';
      acceptCanvasBtn.style.transition = 'background-color 0.2s ease';
      acceptCanvasBtn.onmouseover = () => acceptCanvasBtn.style.backgroundColor = '#e46a3a'; // Darker accent on hover
      acceptCanvasBtn.onmouseout = () => acceptCanvasBtn.style.backgroundColor = 'var(--accent)';

      acceptCanvasBtn.addEventListener('click', () => {
          // Redirect to canvas.html with room ID and username
          window.location.href = `canvas.html?roomId=${data.roomId}&username=${username}`;
      });
      msgContent.appendChild(acceptCanvasBtn);
  }


  const timestampSpan = document.createElement("span");
  timestampSpan.className = "timestamp";
  const date = new Date(timestamp);
  timestampSpan.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  msgContent.appendChild(timestampSpan);

  msgDiv.appendChild(msgContent);
  chatbox.appendChild(msgDiv);
  chatbox.scrollTop = chatbox.scrollHeight; // Ensure scroll to bottom after appending
}


// Socket.IO Event Listeners

// Listener for when the server confirms joining a room
socket.on('roomJoined', ({ chatId, chatName }) => {
  currentChatId = chatId; // Set the actual chat ID received from the server
  console.log(`Joined chat: ${chatName} with ID: ${chatId}`);
  chatWithHeader.textContent = `Chatting with ${chatName}`; // Update header
  socket.emit("loadChat", currentChatId); // Load history for the new chat ID
});

// Listen for incoming room messages
socket.on("roomMessage", ({ sender, message, timestamp }) => {
  // Only append if the message belongs to the currently active chat
  if (currentChatId) { // Assuming server sends chatId with message, which it should
    appendMessage(sender, message, timestamp, sender === username);
    chatbox.scrollTop = chatbox.scrollHeight;
    liveTypingBox.textContent = ""; // Clear typing indicator when a message arrives
  }
});

// Listen for chat history
socket.on("chatHistory", (messages) => {
  // Clear existing messages before loading history, but preserve liveTypingBox
  const existingLiveTypingBox = chatbox.querySelector('#liveTypingBox');
  chatbox.innerHTML = '';
  if (existingLiveTypingBox) {
    chatbox.appendChild(existingLiveTypingBox);
  }

  messages.forEach(({ sender, message, timestamp }) => {
    // Re-check for canvas invite messages when loading history
    if (message.startsWith("CANVAS_INVITE:")) { // Special prefix to identify canvas invites
        const parts = message.split(':');
        const senderUsername = parts[1];
        const roomId = parts[2];
        const chatName = parts[3];
        appendMessage("System", `${senderUsername} has invited you to a collaborative drawing session in "${chatName}".`, new Date(timestamp), false, 'canvasInvite', { roomId, senderUsername });
    } else {
        appendMessage(sender, message, timestamp, sender === username);
    }
  });
  chatbox.scrollTop = chatbox.scrollHeight; // Scroll to bottom after loading history
});

// Listen for live typing indicators
socket.on("showLiveTyping", ({ text, sender }) => {
  if (currentChatId && sender !== username) { // Only show typing if in the same room and not from self
    liveTypingBox.textContent = `${sender} is typing: ${text}`;
  }
});

// Listener for active users (updates the list of currently online users)
socket.on("activeUsers", (users) => {
  // Request chat partners again to combine active users with past chat partners
  socket.activeUsers = users; // Store active users
  socket.emit("requestChatPartners");
});

// Listener for chat partners (users the current user has chatted with, or can chat with)
socket.on('chatPartners', ({ success, partners, message }) => {
  if (success) {
    populateUserList(partners);
  } else {
    console.error("Failed to load chat partners:", message);
    appendMessage("System", `Error loading user list: ${message}`, new Date(), false);
  }
});

// Listener for request sent status
socket.on('requestSentStatus', ({ success, message }) => {
  if (success) {
    appendMessage("System", message, new Date(), false);
  } else {
    appendMessage("System", `Failed to send request: ${message}`, new Date(), false);
  }
});

// Listener for request accepted status
socket.on('requestAcceptedStatus', ({ success, message, chatId }) => {
  if (success) {
    appendMessage("System", message, new Date(), false);
  } else {
    appendMessage("System", `Failed to accept request: ${message}`, new Date(), false);
  }
});

// Listener for request rejected status
socket.on('requestRejectedStatus', ({ success, message }) => {
  if (success) {
    appendMessage("System", message, new Date(), false);
  } else {
    appendMessage("System", `Failed to reject request: ${message}`, new Date(), false);
  }
});

// *** ADDED THIS LISTENER ***
// Listen for server's instruction to update the partner list
socket.on('partnerListShouldUpdate', () => {
  console.log('Received instruction to update partner list. Refetching...');
  socket.emit('requestChatPartners');
});

// Listener for incoming notifications
socket.on('notification', (notification) => {
  console.log('New notification:', notification);
  // Increment count
  let currentCount = parseInt(notificationCountSpan.textContent);
  notificationCountSpan.textContent = currentCount + 1;
  notificationCountSpan.classList.remove('hidden');

  // Add to panel
  addNotificationToPanel(notification);
});

// Listener for initial unread notification count
socket.on('unreadNotificationCount', (count) => {
  notificationCountSpan.textContent = count;
  if (count > 0) {
    notificationCountSpan.classList.remove('hidden');
  } else {
    notificationCountSpan.classList.add('hidden');
  }
});

// Listener for notifications list when panel is opened
socket.on('notificationsList', ({ success, notifications }) => {
  if (success) {
    notificationsListElem.innerHTML = ''; // Clear existing
    if (notifications.length === 0) {
      notificationsListElem.innerHTML = '<li class="no-notifications">No new notifications.</li>';
      markAllReadBtn.classList.add('hidden');
    } else {
      notifications.forEach(notif => addNotificationToPanel(notif));
      markAllReadBtn.classList.remove('hidden');
    }
  } else {
    appendMessage("System", "Failed to load notifications.", new Date(), false);
  }
});

// Listener when a notification is marked as read
socket.on('notificationMarkedRead', ({ success, notificationId }) => {
  if (success) {
    const item = notificationsListElem.querySelector(`[data-notification-id="${notificationId}"]`);
    if (item) {
      item.classList.add('read');
      // Optionally remove mark as read button for this item
      const markReadBtn = item.querySelector('.mark-read-btn');
      if (markReadBtn) markReadBtn.remove();
    }
  }
});

// Listener for group creation success
socket.on('groupCreatedSuccess', ({ success, message, groupId, groupName }) => {
  if (success) {
    appendMessage("System", message, new Date(), false);
    // The 'partnerListShouldUpdate' event will be sent by the server to all members
  } else {
    appendMessage("System", `Failed to create group: ${message}`, new Date(), false);
  }
});

// Listener for all users list (for group creation)
socket.on('allUsersList', ({ success, users }) => {
  if (success) {
    // This event is handled in the createGroupBtn click listener
    // and populates the groupMembersChecklist.
  } else {
    appendMessage("System", "Failed to fetch users for group creation.", new Date(), false);
  }
});


/**
 * Populates the user list (ul#userList) with clickable items.
 * @param {Array<Object>} partners An array of partner objects with status.
 */
function populateUserList(partners) {
  userList.innerHTML = ""; // Clear existing list

  partners.forEach((partner) => {
    const listItem = document.createElement("li");
    listItem.className = "user-item";
    listItem.dataset.username = partner.username;
    listItem.dataset.isGroup = partner.isGroup;
    listItem.dataset.status = partner.status;

    // Add a simple avatar placeholder or group icon
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    if (partner.isGroup) {
      avatar.src = `https://placehold.co/40x40/888888/ffffff?text=GRP`; // Group placeholder
      avatar.alt = "Group Icon";
    } else {
      avatar.src = `https://placehold.co/40x40/cccccc/000000?text=${partner.username.charAt(0).toUpperCase()}`; // User placeholder
      avatar.alt = "User Avatar";
    }
    listItem.appendChild(avatar);

    const usernameSpan = document.createElement("span");
    usernameSpan.className = "username";
    usernameSpan.textContent = partner.username;
    listItem.appendChild(usernameSpan);

    // Add online/offline status dot for direct chats
    if (!partner.isGroup) {
      const statusDot = document.createElement("span");
      statusDot.className = `status-dot ${socket.activeUsers && socket.activeUsers.includes(partner.username) ? 'online' : 'offline'}`;
      listItem.appendChild(statusDot);
    }

    // Add status indicators and action buttons
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "user-item-actions";

    if (partner.isGroup) {
        const groupLabel = document.createElement('span');
        groupLabel.className = 'status-label group-label';
        groupLabel.textContent = 'Group';
        actionsDiv.appendChild(groupLabel);
    } else if (partner.status === 'requestSent') {
      const statusLabel = document.createElement('span');
      statusLabel.className = 'status-label sent-label';
      statusLabel.textContent = 'Request Sent';
      actionsDiv.appendChild(statusLabel);
    } else if (partner.status === 'requestReceived') {
      const statusLabel = document.createElement('span');
      statusLabel.className = 'status-label received-label';
      statusLabel.textContent = 'Request Received';
      actionsDiv.appendChild(statusLabel);

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'action-btn accept-request-btn';
      acceptBtn.dataset.requestId = partner.requestId;
      acceptBtn.textContent = 'Accept';
      actionsDiv.appendChild(acceptBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'action-btn reject-request-btn';
      rejectBtn.dataset.requestId = partner.requestId;
      rejectBtn.textContent = 'Reject';
      actionsDiv.appendChild(rejectBtn);

    } else if (partner.status === 'none') {
      const sendRequestBtn = document.createElement('button');
      sendRequestBtn.className = 'action-btn send-request-btn';
      sendRequestBtn.textContent = 'Send Request';
      actionsDiv.appendChild(sendRequestBtn);
    }
    // No specific buttons for 'chatting' status, as clicking the item opens chat

    listItem.appendChild(actionsDiv);
    userList.appendChild(listItem);
  });
}

/**
 * Adds a notification item to the notification panel.
 * @param {Object} notification The notification object.
 */
function addNotificationToPanel(notification) {
  const li = document.createElement('li');
  li.className = `notification-item ${notification.isRead ? 'read' : ''}`;
  li.dataset.notificationId = notification._id;

  let icon = '';
  switch (notification.type) {
    case 'messageRequest':
      icon = '<i class="fa-solid fa-user-plus"></i>';
      break;
    case 'requestAccepted':
      icon = '<i class="fa-solid fa-check-circle"></i>';
      break;
    case 'requestRejected':
      icon = '<i class="fa-solid fa-times-circle"></i>';
      break;
    case 'groupCreated':
      icon = '<i class="fa-solid fa-users"></i>';
      break;
    case 'newChatMessage':
      icon = '<i class="fa-solid fa-comment"></i>';
      break;
    default:
      icon = '<i class="fa-solid fa-info-circle"></i>';
  }

  const date = new Date(notification.createdAt);
  const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  li.innerHTML = `
    <div class="notification-content">
      ${icon}
      <span>${notification.message}</span>
      <span class="notification-time">${timeString}</span>
    </div>
  `;

  if (!notification.isRead) {
    const markReadBtn = document.createElement('button');
    markReadBtn.className = 'mark-read-btn';
    markReadBtn.innerHTML = '<i class="fa-solid fa-eye"></i>'; // Eye icon
    markReadBtn.title = "Mark as Read";
    markReadBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent li click from interfering
      socket.emit('markNotificationAsRead', { notificationId: notification._id });
    });
    li.appendChild(markReadBtn);
  }

  // Add to the top of the list
  notificationsListElem.prepend(li);
}


// Listen for general chat errors from the server
socket.on('chatError', (message) => {
  console.error("Chat Error:", message);
  // Display error to the user (e.g., in the chatbox or a notification)
  appendMessage("System", `Error: ${message}`, new Date(), false);
});

// Listen for message sending errors
socket.on('messageError', (message) => {
  console.error("Message Error:", message);
  appendMessage("System", `Message Failed: ${message}`, new Date(), false);
});

// Handle Socket.IO connection errors (e.g., invalid token)
socket.on('connect_error', (err) => {
  console.error('Socket connection error:', err.message);
  // Redirect to login if authentication fails
  if (err.message.includes('Authentication error')) {
    localStorage.removeItem("authenticatedUsername");
    localStorage.removeItem("authToken");
    // Using a custom message box instead of alert
    appendMessage("System", "Session expired or invalid. Please log in again.", new Date(), false);

    setTimeout(() => {
      location.href = "/";
    }, 1500);
  }
});
