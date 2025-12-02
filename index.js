require('dotenv').config()
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 5000;



app.use(cors({ origin: '*' }));


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Firebase Admin SDK initialization
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.4a2offu.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false, // ← CHANGE THIS LINE ONLY
    deprecationErrors: true,
  },
  maxPoolSize: 50, // ADD
  minPoolSize: 10, // ADD
  maxIdleTimeMS: 30000 // ADD
});

const getFormattedDateTime = () => {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB');
  const time = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  return { date, time };
};

async function run() {
  try {
    const database = client.db("Planet-of-Health-Pharmacy");
    const categoriesCollections = database.collection("categories");
    const medicinesCollections = database.collection("medicines");
    const adminsCollections = database.collection("admins");
    const ordersCollections = database.collection("orders");
    const fcmTokensCollections = database.collection("fcmTokens");
    const usersCollections = database.collection("users");
    const cartsCollections = database.collection("carts");


    // ADD THIS HELPER FUNCTION:
    const createIndexIfNotExists = async (collection, indexSpec, options = {}) => {
      try {
        const indexes = await collection.indexes();
        const indexName = options.name || Object.keys(indexSpec).map(k => `${k}_${indexSpec[k]}`).join('_');

        const exists = indexes.some(idx => idx.name === indexName);

        if (!exists) {
          await collection.createIndex(indexSpec, options);
          console.log(`Created index: ${indexName}`);
        }
      } catch (error) {
        console.log(`Index already exists or error: ${error.message}`);
      }
    };

    // CREATE INDEXES SAFELY:
    await createIndexIfNotExists(medicinesCollections, { 'en.name': 1 });
    await createIndexIfNotExists(medicinesCollections, { 'ru.name': 1 });
    await createIndexIfNotExists(medicinesCollections, { generic: 1 });
    await createIndexIfNotExists(medicinesCollections, { companyName: 1 });
    await createIndexIfNotExists(medicinesCollections, { categoryId: 1 });
    await createIndexIfNotExists(usersCollections, { uid: 1 });
    await createIndexIfNotExists(ordersCollections, { userId: 1 });
    await createIndexIfNotExists(ordersCollections, { orderDate: -1 });
    await createIndexIfNotExists(cartsCollections, { uid: 1 });
    await createIndexIfNotExists(fcmTokensCollections, { adminId: 1 });


    let categoriesCache = null;
    let cacheTimestamp = null;
    const CACHE_DURATION = 5 * 60 * 1000;
    const clearCategoriesCache = () => {
      categoriesCache = null;
      cacheTimestamp = null;
    };
    // ==================== USER ROUTES ====================

    // Create/Update User (Firebase Auth Info)
    app.post('/users', async (req, res) => {
      const { uid, email, displayName, photoURL, phoneNumber } = req.body;

      if (!uid || !email) {
        return res.status(400).send({ message: 'UID and email required' });
      }

      const { date, time } = getFormattedDateTime();

      const existingUser = await usersCollections.findOne({ uid });

      if (existingUser) {
        await usersCollections.updateOne(
          { uid },
          {
            $set: {
              email,
              displayName,
              photoURL,
              phoneNumber,
              lastLoginDate: date,
              lastLoginTime: time
            }
          }
        );
        res.send({ message: 'User updated', userId: existingUser._id });
      } else {
        const newUser = {
          uid,
          email,
          displayName: displayName || null,
          photoURL: photoURL || null,
          phoneNumber: phoneNumber || null,
          role: 'customer',
          createdDate: date,
          createdTime: time,
          lastLoginDate: date,
          lastLoginTime: time
        };

        const result = await usersCollections.insertOne(newUser);
        res.send({ message: 'User created', userId: result.insertedId });
      }
    });
    // User Login (Firebase UID-based)
    app.post('/login', async (req, res) => {
      const { uid } = req.body;

      if (!uid) {
        return res.status(400).send({ message: 'UID required' });
      }

      const user = await usersCollections.findOne({ uid });

      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }

      const { date, time } = getFormattedDateTime();

      // Update last login
      await usersCollections.updateOne(
        { uid },
        {
          $set: {
            lastLoginDate: date,
            lastLoginTime: time
          }
        }
      );

      res.send({ message: 'Login successful', user });
    });
    // Get User by UID
    app.get('/users/:uid', async (req, res) => {
      const { uid } = req.params;
      const user = await usersCollections.findOne({ uid });

      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }

      res.send(user);
    });

    // Get All Users (Admin)
    app.get('/users', async (req, res) => {
      const users = await usersCollections.find().sort({ _id: -1 }).toArray();
      res.send(users);
    });

    // Update User Profile
    app.put('/users/:uid', async (req, res) => {
      const { uid } = req.params;
      const { displayName, phoneNumber, photoURL, address } = req.body;
      const { date, time } = getFormattedDateTime();

      const result = await usersCollections.updateOne(
        { uid },
        {
          $set: {
            displayName,
            phoneNumber,
            photoURL,
            address,
            updatedDate: date,
            updatedTime: time
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'User not found' });
      }

      res.send({ message: 'Profile updated' });
    });


    // ==================== GALLERY ROUTES ====================

    // Get All Gallery Images
    app.get('/gallery', async (req, res) => {
      const images = await database.collection('gallery')
        .find()
        .sort({ order: 1 })
        .toArray();
      res.send(images);
    });

    // Get Single Gallery Image
    app.get('/gallery/:id', async (req, res) => {
      const { id } = req.params;
      const image = await database.collection('gallery').findOne({ _id: new ObjectId(id) });

      if (!image) {
        return res.status(404).send({ message: 'Image not found' });
      }

      res.send(image);
    });

    // Add Gallery Image
    app.post('/gallery', async (req, res) => {
      const data = req.body;
      const { date, time } = getFormattedDateTime();

      // Get the highest order number
      const lastImage = await database.collection('gallery')
        .find()
        .sort({ order: -1 })
        .limit(1)
        .toArray();

      data.order = lastImage.length > 0 ? lastImage[0].order + 1 : 0;
      data.createdDate = date;
      data.createdTime = time;

      const result = await database.collection('gallery').insertOne(data);
      res.send(result);
    });

    // Update Gallery Image
    app.put('/gallery/:id', async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;
      const { date, time } = getFormattedDateTime();

      delete updateData._id;
      updateData.updatedDate = date;
      updateData.updatedTime = time;

      const result = await database.collection('gallery').updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'Image not found' });
      }

      res.send(result);
    });

    // Update Gallery Order (Drag & Drop)
    app.put('/gallery/reorder', async (req, res) => {
      const { images } = req.body; // Array of { id, order }
      const { date, time } = getFormattedDateTime();

      try {
        const bulkOps = images.map((img, index) => ({
          updateOne: {
            filter: { _id: new ObjectId(img.id) },
            update: {
              $set: {
                order: index,
                updatedDate: date,
                updatedTime: time
              }
            }
          }
        }));

        const result = await database.collection('gallery').bulkWrite(bulkOps);
        res.send({ message: 'Order updated', result });
      } catch (error) {
        res.status(500).send({ error: 'Failed to update order' });
      }
    });

    // Delete Gallery Image
    app.delete('/gallery/:id', async (req, res) => {
      const { id } = req.params;
      const result = await database.collection('gallery').deleteOne({ _id: new ObjectId(id) });

      if (result.deletedCount === 0) {
        return res.status(404).send({ message: 'Image not found' });
      }

      res.send(result);
    });


    // ==================== WHATSAPP ORDER ROUTE ====================

    // Generate WhatsApp Order Link AND Create Order in Database
    app.post('/generate-whatsapp-order', async (req, res) => {
      try {
        const { userId } = req.body;

        if (!userId) {
          return res.status(400).send({ message: 'User ID required' });
        }

        // Get user info
        const user = await usersCollections.findOne({ uid: userId });
        if (!user) {
          return res.status(404).send({ message: 'User not found' });
        }

        // Get user cart
        const cart = await cartsCollections.findOne({ uid: userId });
        if (!cart || !cart.items || cart.items.length === 0) {
          return res.status(400).send({ message: 'Cart is empty' });
        }

        // ✅ FIXED: Get all medicines at once
        const medicineIds = cart.items.map(item => new ObjectId(item.medicineId));
        const medicines = await medicinesCollections.find({
          _id: { $in: medicineIds }
        }).toArray();

        const medicineMap = {};
        medicines.forEach(med => {
          medicineMap[med._id.toString()] = med;
        });

        const orderItems = [];
        const medicineDetails = [];
        let subtotal = 0;

        for (const item of cart.items) {
          const medicine = medicineMap[item.medicineId];

          if (medicine) {
            const price = medicine.discountPrice || medicine.price;
            const itemTotal = price * item.quantity;
            subtotal += itemTotal;

            orderItems.push({
              name: medicine.en.name,
              quantity: item.quantity,
              price: price,
              total: itemTotal
            });

            medicineDetails.push({
              medicineId: item.medicineId,
              name: medicine.en.name,
              quantity: item.quantity,
              price: price,
              total: itemTotal
            });
          }
        }

        const vat = subtotal * 0.02;
        const discount = subtotal * 0.05;
        const grandTotal = subtotal + vat - discount;
        const { date, time } = getFormattedDateTime();

        const orderData = {
          userId: user.uid,
          userEmail: user.email,
          userName: user.displayName || 'Guest',
          userPhone: user.phoneNumber || 'Not provided',
          deliveryAddress: user.address || 'Not provided',
          medicines: medicineDetails,
          subtotal: subtotal,
          vat: vat,
          discount: discount,
          totalPrice: grandTotal,
          orderType: 'whatsapp', // Mark as WhatsApp order
          status: 'Pending',
          orderDate: date,
          orderTime: time
        };

        const orderResult = await ordersCollections.insertOne(orderData);

        // ✅ CLEAR USER CART
        await cartsCollections.deleteOne({ uid: userId });

        // Create WhatsApp message with Order ID
        let message = `🛒 *NEW ORDER #${orderResult.insertedId}*\n\n`;
        message += `👤 *Customer Details:*\n`;
        message += `Name: ${user.displayName || 'Guest'}\n`;
        message += `Email: ${user.email}\n`;
        message += `Phone: ${user.phoneNumber || 'Not provided'}\n\n`;
        message += `Address: ${user.address || 'Not provided'}\n\n`;

        message += `📦 *Order Items:*\n`;
        message += `━━━━━━━━━━━━━━━━\n`;

        orderItems.forEach((item, index) => {
          message += `${index + 1}. ${item.name}\n`;
          message += `   Qty: ${item.quantity} × $${item.price.toFixed(2)} = $${item.total.toFixed(2)}\n\n`;
        });

        message += `━━━━━━━━━━━━━━━━\n`;
        message += `💰 *Price Summary:*\n`;
        message += `Subtotal: $${subtotal.toFixed(2)}\n`;
        message += `VAT (2%): $${vat.toFixed(2)}\n`;
        message += `Discount (5%): -$${discount.toFixed(2)}\n`;
        message += `━━━━━━━━━━━━━━━━\n`;
        message += `*Grand Total: $${grandTotal.toFixed(2)}*\n\n`;
        message += `📅 Order Date: ${date} ${time}\n`;
        message += `🆔 Order ID: ${orderResult.insertedId}\n\n`;
        message += `✅ I want to confirm this order!`;

        // Admin WhatsApp number (replace with your number)
        const adminWhatsApp = '8801629270683'; // Change this to your WhatsApp number

        // Generate WhatsApp link
        const whatsappLink = `https://wa.me/${adminWhatsApp}?text=${encodeURIComponent(message)}`;

        // ✅ SEND NOTIFICATION TO ADMIN (if FCM is set up)
        try {
          const allTokens = await fcmTokensCollections.find({}).toArray();

          for (const tokenDoc of allTokens) {
            try {
              await admin.messaging().send({
                notification: {
                  title: '🛒 New WhatsApp Order',
                  body: `Order #${orderResult.insertedId} - ${user.displayName || user.email} - $${grandTotal.toFixed(2)}`,
                },
                data: {
                  orderId: orderResult.insertedId.toString(),
                  orderType: 'whatsapp',
                  click_action: '/orders'
                },
                token: tokenDoc.token
              });
            } catch (error) {
              console.error('FCM notification failed:', error);
            }
          }
        } catch (error) {
          console.log('No FCM tokens found or notification failed');
        }

        res.json({
          success: true,
          whatsappLink,
          orderId: orderResult.insertedId,
          orderSummary: {
            items: orderItems,
            subtotal,
            vat,
            discount,
            grandTotal
          }
        });

      } catch (error) {
        console.error('WhatsApp order generation error:', error);
        res.status(500).send({ error: 'Failed to generate WhatsApp order' });
      }
    });






    // ==================== CART ROUTES ====================

    // Add item to cart (Simple insertion)
    app.post('/cart', async (req, res) => {
      try {
        const cartItem = req.body;
        cartItem.createdAt = new Date();

        const result = await cartsCollections.insertOne(cartItem);
        res.send(result);
      } catch (error) {
        console.error("Error adding to cart:", error);
        res.status(500).send({ error: "Failed to add item to cart" });
      }
    });

    // Get User Cart
    // Get User Cart - OPTIMIZED
    app.get('/cart/:uid', async (req, res) => {
      const { uid } = req.params;
      let cart = await cartsCollections.findOne({ uid });

      if (!cart || !cart.items || cart.items.length === 0) {
        return res.send({ uid, items: [] });
      }

      // Get all medicine IDs at once
      const medicineIds = cart.items.map(item => new ObjectId(item.medicineId));

      // Single query instead of multiple
      const medicines = await medicinesCollections.find({
        _id: { $in: medicineIds }
      }).toArray();

      // Get unique category IDs
      const categoryIds = [...new Set(medicines.map(m => new ObjectId(m.categoryId)))];

      // Single query for categories
      const categories = await categoriesCollections.find({
        _id: { $in: categoryIds }
      }).toArray();

      // Create category map
      const categoryMap = {};
      categories.forEach(cat => {
        categoryMap[cat._id.toString()] = cat.name;
      });

      // Map medicines
      const medicineMap = {};
      medicines.forEach(med => {
        medicineMap[med._id.toString()] = {
          _id: med._id,
          image: med.image,
          power: med.power,
          companyName: med.companyName,
          quantity: med.quantity,
          price: med.price,
          discountPrice: med.discountPrice,
          generic: med.generic,
          categoryName: categoryMap[med.categoryId] || 'Unknown',
          en: med.en,
          ru: med.ru
        };
      });

      // Populate items
      cart.items = cart.items
        .map(item => ({
          ...item,
          medicine: medicineMap[item.medicineId]
        }))
        .filter(item => item.medicine);

      res.send(cart);
    });
    // Add to Cart with UID
    app.post('/cart/:uid', async (req, res) => {
      const { uid } = req.params;
      const { medicineId, quantity } = req.body;

      if (!medicineId || !quantity) {
        return res.status(400).send({ message: 'Medicine ID and quantity required' });
      }

      const medicine = await medicinesCollections.findOne({ _id: new ObjectId(medicineId) });
      if (!medicine) {
        return res.status(404).send({ message: 'Medicine not found' });
      }

      const { date, time } = getFormattedDateTime();

      let cart = await cartsCollections.findOne({ uid });

      if (!cart) {
        cart = {
          uid,
          items: [],
          createdDate: date,
          createdTime: time
        };
      }

      // FIX: Ensure items array exists
      if (!cart.items) {
        cart.items = [];
      }

      const existingItemIndex = cart.items.findIndex(item => item.medicineId === medicineId);

      if (existingItemIndex !== -1) {
        cart.items[existingItemIndex].quantity += quantity;
      } else {
        cart.items.push({ medicineId, quantity });
      }

      cart.updatedDate = date;
      cart.updatedTime = time;

      await cartsCollections.updateOne(
        { uid },
        { $set: cart },
        { upsert: true }
      );

      res.send({ message: 'Added to cart', cart });
    });

    // Update Cart Item Quantity
    app.put('/cart/:uid/:medicineId', async (req, res) => {
      const { uid, medicineId } = req.params;
      const { quantity } = req.body;

      if (quantity < 1) {
        return res.status(400).send({ message: 'Quantity must be at least 1' });
      }

      const { date, time } = getFormattedDateTime();

      const result = await cartsCollections.updateOne(
        { uid, 'items.medicineId': medicineId },
        {
          $set: {
            'items.$.quantity': quantity,
            updatedDate: date,
            updatedTime: time
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'Cart item not found' });
      }

      res.send({ message: 'Cart updated' });
    });

    // Remove from Cart
    app.delete('/cart/:uid/:medicineId', async (req, res) => {
      const { uid, medicineId } = req.params;
      const { date, time } = getFormattedDateTime();

      const result = await cartsCollections.updateOne(
        { uid },
        {
          $pull: { items: { medicineId } },
          $set: { updatedDate: date, updatedTime: time }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'Cart not found' });
      }

      res.send({ message: 'Item removed from cart' });
    });

    // Clear Cart
    app.delete('/cart/:uid', async (req, res) => {
      const { uid } = req.params;

      const result = await cartsCollections.deleteOne({ uid });

      if (result.deletedCount === 0) {
        return res.status(404).send({ message: 'Cart not found' });
      }

      res.send({ message: 'Cart cleared' });
    });

    // ==================== MEDICINE SEARCH (AUTOCOMPLETE) ====================

    // Real-time Search Suggestions (Autocomplete)
    app.get('/medicines/suggestions', async (req, res) => {
      const searchQuery = req.query.query;

      if (!searchQuery || searchQuery.length < 1) {
        return res.send([]);
      }

      const query = {
        $or: [
          { 'en.name': { $regex: searchQuery, $options: 'i' } },
          { 'ru.name': { $regex: searchQuery, $options: 'i' } },
          { generic: { $regex: searchQuery, $options: 'i' } },
          { companyName: { $regex: searchQuery, $options: 'i' } }
        ]
      };

      const medicines = await medicinesCollections
        .find(query)
        .limit(10)
        .project({
          _id: 1,
          'en.name': 1,
          'ru.name': 1,
          generic: 1,
          image: 1,
          price: 1,
          discountPrice: 1
        })
        .toArray();

      res.send(medicines);
    });

    // ==================== ORDER ROUTES (ENHANCED) ====================

    // Create Order (with User Info)
    app.post('/orders', async (req, res) => {
      const data = req.body;
      const { date, time } = getFormattedDateTime();

      if (!data.userId) {
        return res.status(400).send({ message: 'User ID required' });
      }

      // Get user info
      const user = await usersCollections.findOne({ uid: data.userId });
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }

      data.orderDate = date;
      data.orderTime = time;
      data.status = 'Pending';
      data.userEmail = user.email;
      data.userName = user.displayName || 'Guest';
      data.userPhone = data.phoneNumber || user.phoneNumber;
      data.deliveryAddress = user.address || 'Not provided';

      let totalPrice = 0;
      const medicineDetails = [];

      for (let item of data.medicines) {
        const medicine = await medicinesCollections.findOne({ _id: new ObjectId(item.medicineId) });
        if (medicine) {
          const itemTotal = (medicine.discountPrice || medicine.price) * item.quantity;
          totalPrice += itemTotal;

          medicineDetails.push({
            medicineId: item.medicineId,
            name: medicine.en.name,
            quantity: item.quantity,
            price: medicine.discountPrice || medicine.price,
            total: itemTotal
          });
        }
      }

      data.medicines = medicineDetails;
      data.totalPrice = totalPrice;

      const result = await ordersCollections.insertOne(data);

      // Clear user cart after order
      await cartsCollections.deleteOne({ uid: data.userId });

      // Send notification to all admins
      const allTokens = await fcmTokensCollections.find({}).toArray();

      for (const tokenDoc of allTokens) {
        try {
          await admin.messaging().send({
            notification: {
              title: 'New Order Received',
              body: `Order #${result.insertedId} - ${user.displayName || user.email} - $${totalPrice}`,
            },
            data: {
              orderId: result.insertedId.toString(),
              click_action: '/orders'
            },
            token: tokenDoc.token
          });
        } catch (error) {
          console.error('Failed to send notification:', error);
        }
      }

      res.send(result);
    });

    // Get Orders by User
    app.get('/orders/user/:uid', async (req, res) => {
      const { uid } = req.params;
      const orders = await ordersCollections.find({ userId: uid }).sort({ _id: -1 }).toArray();
      res.send(orders);
    });

    // Get All Orders (Admin)
    app.get('/orders', async (req, res) => {
      const orders = await ordersCollections.find().sort({ _id: -1 }).toArray();
      res.send(orders);
    });

    // Get Single Order
    app.get('/orders/:id', async (req, res) => {
      const { id } = req.params;
      const order = await ordersCollections.findOne({ _id: new ObjectId(id) });

      if (!order) {
        return res.status(404).send({ message: 'Order not found' });
      }

      res.send(order);
    });

    // Update Order Status (Admin)
    app.put('/orders/:id/status', async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      const { date, time } = getFormattedDateTime();

      const validStatuses = ['Pending', 'Confirmed', 'Delivered', 'Cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).send({ message: 'Invalid status' });
      }

      const result = await ordersCollections.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updatedDate: date, updatedTime: time } }
      );

      res.send(result);
    });

    // Delete Order (Admin)
    app.delete('/orders/:id', async (req, res) => {
      const { id } = req.params;
      const result = await ordersCollections.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });




    // ==================== USER ORDER MANAGEMENT ====================

    // Cancel Order (User can only cancel Pending orders)
    app.put('/orders/:id/cancel', async (req, res) => {
      const { id } = req.params;
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).send({ message: 'User ID required' });
      }

      const order = await ordersCollections.findOne({ _id: new ObjectId(id) });

      if (!order) {
        return res.status(404).send({ message: 'Order not found' });
      }

      // Check if order belongs to user
      if (order.userId !== userId) {
        return res.status(403).send({ message: 'Unauthorized' });
      }

      // Only pending orders can be cancelled
      if (order.status !== 'Pending') {
        return res.status(400).send({
          message: `Cannot cancel ${order.status.toLowerCase()} orders`
        });
      }

      const { date, time } = getFormattedDateTime();

      const result = await ordersCollections.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: 'Cancelled',
            cancelledDate: date,
            cancelledTime: time,
            updatedDate: date,
            updatedTime: time
          }
        }
      );

      res.send({ message: 'Order cancelled successfully', result });
    });

    // Get Order Status History (Optional - for tracking)
    app.get('/orders/:id/status', async (req, res) => {
      const { id } = req.params;

      const order = await ordersCollections.findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            status: 1,
            orderDate: 1,
            orderTime: 1,
            updatedDate: 1,
            updatedTime: 1,
            cancelledDate: 1,
            cancelledTime: 1
          }
        }
      );

      if (!order) {
        return res.status(404).send({ message: 'Order not found' });
      }

      res.send(order);
    });


    // ==================== ADMIN AUTH ROUTES ====================

    // Admin Login
    app.post('/admin/login', async (req, res) => {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).send({ message: 'Email and password required' });
      }

      const admin = await adminsCollections.findOne({ email });
      if (!admin) {
        return res.status(401).send({ message: 'Invalid credentials' });
      }

      const isPasswordValid = await bcrypt.compare(password, admin.password);
      if (!isPasswordValid) {
        return res.status(401).send({ message: 'Invalid credentials' });
      }

      const { password: _, ...adminWithoutPassword } = admin;
      res.send({ message: 'Login successful', admin: adminWithoutPassword });
    });

    // Create Admin (first time setup)
    app.post('/admin/create', async (req, res) => {
      const { email, password, name } = req.body;

      if (!email || !password || !name) {
        return res.status(400).send({ message: 'All fields required' });
      }

      const existingAdmin = await adminsCollections.findOne({ email });
      if (existingAdmin) {
        return res.status(400).send({ message: 'Admin already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const { date, time } = getFormattedDateTime();

      const newAdmin = {
        email,
        password: hashedPassword,
        name,
        role: 'admin',
        createdDate: date,
        createdTime: time
      };

      const result = await adminsCollections.insertOne(newAdmin);
      res.send({ message: 'Admin created', adminId: result.insertedId });
    });

    // Change Admin Password
    app.put('/admin/change-password/:id', async (req, res) => {
      const { id } = req.params;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).send({ message: 'Both passwords required' });
      }

      const admin = await adminsCollections.findOne({ _id: new ObjectId(id) });
      if (!admin) {
        return res.status(404).send({ message: 'Admin not found' });
      }

      const isPasswordValid = await bcrypt.compare(currentPassword, admin.password);
      if (!isPasswordValid) {
        return res.status(401).send({ message: 'Current password incorrect' });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const { date, time } = getFormattedDateTime();

      await adminsCollections.updateOne(
        { _id: new ObjectId(id) },
        { $set: { password: hashedPassword, updatedDate: date, updatedTime: time } }
      );

      res.send({ message: 'Password changed successfully' });
    });

    // Save FCM Token
    app.post('/admin/save-fcm-token', async (req, res) => {
      const { adminId, token } = req.body;

      if (!adminId || !token) {
        return res.status(400).send({ message: 'Admin ID and token required' });
      }

      const { date, time } = getFormattedDateTime();

      await fcmTokensCollections.updateOne(
        { adminId },
        { $set: { token, updatedDate: date, updatedTime: time } },
        { upsert: true }
      );

      res.send({ message: 'Token saved' });
    });

    // Send Notification
    app.post('/send-notification', async (req, res) => {
      const { adminId, title, body, orderId } = req.body;

      try {
        const tokenDoc = await fcmTokensCollections.findOne({ adminId });

        if (!tokenDoc || !tokenDoc.token) {
          return res.status(404).send({ message: 'FCM token not found' });
        }

        const message = {
          notification: {
            title: title || 'New Order Received',
            body: body || 'You have a new order',
          },
          data: {
            orderId: orderId || '',
            click_action: '/orders'
          },
          token: tokenDoc.token
        };

        const response = await admin.messaging().send(message);
        res.send({ message: 'Notification sent', response });
      } catch (error) {
        console.error('FCM Error:', error);
        res.status(500).send({ message: 'Failed to send notification', error: error.message });
      }
    });

    // ==================== CATEGORY ROUTES ====================

    app.get('/categories', async (req, res) => {
      const now = Date.now();

      // Return cache if valid
      if (categoriesCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
        return res.send(categoriesCache);
      }

      const categories = await categoriesCollections.find().toArray();
      const categoryIds = categories.map(cat => cat._id.toString());

      // Aggregate count in single query
      const counts = await medicinesCollections.aggregate([
        { $match: { categoryId: { $in: categoryIds } } },
        { $group: { _id: "$categoryId", count: { $sum: 1 } } }
      ]).toArray();

      const countMap = {};
      counts.forEach(c => {
        countMap[c._id] = c.count;
      });

      const result = categories.map(cat => ({
        _id: cat._id,
        name: cat.name,
        name_ru: cat.name_ru,
        description: cat.description,
        description_ru: cat.description_ru,
        medicineCount: countMap[cat._id.toString()] || 0,
        createdDate: cat.createdDate,
        createdTime: cat.createdTime
      }));

      // Update cache
      categoriesCache = result;
      cacheTimestamp = now;

      res.send(result);
    });

    app.post('/categories', async (req, res) => {
      const data = req.body;
      const { date, time } = getFormattedDateTime();

      data.createdDate = date;
      data.createdTime = time;

      const result = await categoriesCollections.insertOne(data);
      clearCategoriesCache();
      res.send(result);
    });

    app.put('/categories/:id', async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;
      const { date, time } = getFormattedDateTime();

      updateData.updatedDate = date;
      updateData.updatedTime = time;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: updateData };
      const result = await categoriesCollections.updateOne(filter, updateDoc);
      clearCategoriesCache();
      res.send(result);
    });

    app.delete('/categories/:id', async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await categoriesCollections.deleteOne(query);
      clearCategoriesCache();
      res.send(result);
    });

    // ==================== MEDICINE ROUTES ====================

    app.get('/medicines', async (req, res) => {
      const medicines = await medicinesCollections.find().toArray();

      const result = await Promise.all(
        medicines.map(async (med) => {
          const category = await categoriesCollections.findOne({
            _id: new ObjectId(med.categoryId)
          });

          return {
            _id: med._id,
            image: med.image,
            power: med.power,
            companyName: med.companyName,
            quantity: med.quantity,
            price: med.price,
            discountPrice: med.discountPrice,
            generic: med.generic,
            categoryId: med.categoryId,
            categoryName: category ? category.name : 'Unknown',
            categoryName_ru: category ? category.name_ru : 'Unknown',
            en: med.en,
            ru: med.ru,
            createdDate: med.createdDate,
            createdTime: med.createdTime
          };
        })
      );

      res.send(result);
    });

    app.get('/medicines/search', async (req, res) => {
      const searchQuery = req.query.query;

      if (!searchQuery) {
        return res.status(400).send({ message: 'Search query required' });
      }

      // Use text index for faster search
      const medicines = await medicinesCollections.find(
        { $text: { $search: searchQuery } },
        { score: { $meta: "textScore" } }
      )
        .sort({ score: { $meta: "textScore" } })
        .limit(50) // Add limit
        .toArray();

      if (medicines.length === 0) {
        return res.send([]);
      }

      // Batch fetch categories
      const categoryIds = [...new Set(medicines.map(m => new ObjectId(m.categoryId)))];
      const categories = await categoriesCollections.find({
        _id: { $in: categoryIds }
      }).toArray();

      const categoryMap = {};
      categories.forEach(cat => {
        categoryMap[cat._id.toString()] = {
          name: cat.name,
          name_ru: cat.name_ru
        };
      });

      const result = medicines.map(med => ({
        _id: med._id,
        image: med.image,
        power: med.power,
        companyName: med.companyName,
        quantity: med.quantity,
        price: med.price,
        discountPrice: med.discountPrice,
        generic: med.generic,
        categoryId: med.categoryId,
        categoryName: categoryMap[med.categoryId]?.name || 'Unknown',
        categoryName_ru: categoryMap[med.categoryId]?.name_ru || 'Unknown',
        en: med.en,
        ru: med.ru,
        createdDate: med.createdDate,
        createdTime: med.createdTime
      }));

      res.send(result);
    });

    app.get('/medicines/category/:categoryId', async (req, res) => {
      const { categoryId } = req.params;
      const query = { categoryId: categoryId };
      const medicines = await medicinesCollections.find(query).toArray();

      const result = await Promise.all(
        medicines.map(async (med) => {
          const category = await categoriesCollections.findOne({
            _id: new ObjectId(med.categoryId)
          });

          return {
            _id: med._id,
            image: med.image,
            power: med.power,
            companyName: med.companyName,
            quantity: med.quantity,
            price: med.price,
            discountPrice: med.discountPrice,
            generic: med.generic,
            categoryId: med.categoryId,
            categoryName: category ? category.name : 'Unknown',
            categoryName_ru: category ? category.name_ru : 'Unknown',
            en: med.en,
            ru: med.ru,
            createdDate: med.createdDate,
            createdTime: med.createdTime
          };
        })
      );

      res.send(result);
    });

    app.get('/medicines/:id', async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const med = await medicinesCollections.findOne(query);

      if (!med) {
        return res.status(404).send({ message: 'Medicine not found' });
      }

      const category = await categoriesCollections.findOne({
        _id: new ObjectId(med.categoryId)
      });

      const result = {
        _id: med._id,
        image: med.image,
        power: med.power,
        companyName: med.companyName,
        quantity: med.quantity,
        price: med.price,
        discountPrice: med.discountPrice,
        generic: med.generic,
        categoryId: med.categoryId,
        categoryName: category ? category.name : 'Unknown',
        categoryName_ru: category ? category.name_ru : 'Unknown',
        en: med.en,
        ru: med.ru,
        createdDate: med.createdDate,
        createdTime: med.createdTime
      };

      res.send(result);
    });

    app.post('/medicines', async (req, res) => {
      const data = req.body;
      const { date, time } = getFormattedDateTime();

      const category = await categoriesCollections.findOne({
        _id: new ObjectId(data.categoryId)
      });

      if (!category) {
        return res.status(404).send({ message: 'Category not found' });
      }

      data.categoryName = category.name;
      data.categoryName_ru = category.name_ru || category.name;
      data.createdDate = date;
      data.createdTime = time;

      const result = await medicinesCollections.insertOne(data);
      res.send(result);
    });

    app.put('/medicines/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const updateData = { ...req.body };

        delete updateData._id;

        const { date, time } = getFormattedDateTime();

        if (updateData.categoryId && !ObjectId.isValid(updateData.categoryId)) {
          return res.status(400).json({ message: "Invalid category ID" });
        }

        if (updateData.categoryId) {
          const category = await categoriesCollections.findOne({
            _id: new ObjectId(updateData.categoryId)
          });

          if (!category) {
            return res.status(404).send({ message: 'Category not found' });
          }

          updateData.categoryName = category.name;
          updateData.categoryName_ru = category.name_ru || category.name;
        }

        updateData.updatedDate = date;
        updateData.updatedTime = time;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: updateData };
        const result = await medicinesCollections.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Medicine not found" });
        }

        res.send({ success: true, result });
      } catch (err) {
        console.error("PUT /medicines/:id Error:", err);
        res.status(500).json({ message: "Internal Server Error", error: err.message });
      }
    });

    app.delete('/medicines/:id', async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await medicinesCollections.deleteOne(query);
      res.send(result);
    });

    app.get('/medicine_count', async (req, res) => {
      const result = await medicinesCollections.estimatedDocumentCount()
      res.send({ count: result })
    })
    app.get('/pagenition_medicines', async (req, res) => {
      const skip = parseInt(req.query.skip)

      const result = await medicinesCollections.find().skip(skip * 6).limit(6).toArray()
      console.log(skip)
      res.send(result)
    })

    console.log("✅ Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send("Medicine Store Server is Running")
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`)
  console.log(`Local: http://localhost:${port}`)
  console.log(`Network: 192.168.31.152:${port}`)
})