require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db } = require('./firebase');
const { collection, addDoc, doc, setDoc, getDoc, writeBatch, increment } = require('firebase/firestore');

const app = express();

// إعداد CORS بشكل موسع
app.use(cors({
  origin: ["https://big-store-bj54000.vercel.app", "http://localhost:5187"],
  methods: "GET, POST, OPTIONS",
  allowedHeaders: "Content-Type",
}));

// دعم الـ preflight requests
app.options('*', (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(200).end();
});

app.use(express.json());

const YOUR_DOMAIN = 'http://localhost:4242';

// إنشاء جلسة Checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    console.log("Received request body:", req.body);
    const { paymentMethod, selectedAddress, cartItems, totalAmount, shippingFee, userId, language } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'لا توجد منتجات في السلة!' });
    }

    const cartRef = await addDoc(collection(db, 'carts'), {
      userId,
      products: cartItems,
      createdAt: new Date().toISOString(),
    });

    const lineItems = cartItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.isOffer 
            ? `Special Offer: ${item.title[language]} (${item.products.length} Items)` 
            : item.title[language],
          images: [item.isOffer ? item.products[0].imageUrl : item.imageUrl],
          description: item.isOffer 
            ? `This offer contains ${item.products.length} products.` 
            : `Regular product`,
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      line_items: lineItems,
      mode: 'payment',
      success_url: `http://localhost:3000/success?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:3000?canceled=true`,
      metadata: {
        cartId: cartRef.id,
        address: JSON.stringify(selectedAddress),
        totalAmount,
        shippingFee,
        userId,
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({ error: error.message });
  }
});

// نجاح الدفع
app.post('/checkout-success', async (req, res) => {
  const { sessionId } = req.body;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session && session.payment_status === 'paid') {
      const { userId, address, cartId, totalAmount, shippingFee } = session.metadata;

      if (!userId || !address || !cartId || !totalAmount || !shippingFee) {
        return res.status(400).send('Invalid metadata or missing data.');
      }

      const cartDocRef = doc(db, 'carts', cartId);
      const cartDoc = await getDoc(cartDocRef);

      if (!cartDoc.exists()) {
        return res.status(400).send('Cart not found.');
      }

      const cartItems = cartDoc.data().products;

      if (!cartItems || cartItems.length === 0) {
        return res.status(400).send('No products found in cart.');
      }

      const order = {
        userId,
        address: JSON.parse(address),
        products: cartItems,
        totalAmount,
        shippingFee,
        orderDate: new Date().toISOString(),
        deliveryDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        paymentMethod: 'online',
        status: 'Paid',
        orderStatus: "Processing",
      };

      await addDoc(collection(db, 'Orders'), order);

      const batch = writeBatch(db);
      cartItems.forEach((item) => {
        const productRef = doc(db, "products", String(item.id));
        batch.update(productRef, {
          stock: increment(-item.quantity),
          sales: increment(item.quantity),
        });
      });

      await batch.commit();

      await setDoc(cartDocRef, { status: 'paid' });

      res.status(200).send('Order successfully saved in Firebase, and stock updated.');
    } else {
      res.status(400).send('Payment was not successful.');
    }
  } catch (error) {
    console.error("Error during checkout success:", error);
    res.status(500).send('Internal server error.');
  }
});


// Route لاختبار السيرفر
app.get('/', (req, res) => {
  res.send('Backend is working');
});
