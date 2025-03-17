require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db } = require('./firebase'); // استيراد db من ملف التهيئة
const { collection, addDoc, doc, setDoc, getDoc, writeBatch, increment } = require('firebase/firestore');

const app = express();

// إعداد CORS
const cors = require("cors");

app.use(cors({
  origin: ["http://localhost:5184", "https://big-store-bj54000.vercel.app"],
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: "Content-Type, Authorization"
}));
app.options("*", cors());
app.use(express.json());


// Route لإنشاء جلسة Checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { paymentMethod, selectedAddress, cartItems, totalAmount, shippingFee, userId, language } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'لا توجد منتجات في السلة!' });
    }

    // تخزين cartItems في Firestore
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

    // إنشاء جلسة Checkout
    const session = await stripe.checkout.sessions.create({
      line_items: lineItems,
      mode: 'payment',
      success_url: `https://big-store-bj54000.vercel.app/success?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://big-store-bj54000.vercel.app?canceled=true`,
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

// Route للتعامل مع نجاح الدفع
app.post('/checkout-success', async (req, res) => {
  const { sessionId } = req.body;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session && session.payment_status === 'paid') {
      const { userId, address, cartId, totalAmount, shippingFee } = session.metadata;

      if (!userId || !address || !cartId || !totalAmount || !shippingFee) {
        return res.status(400).send('Invalid metadata or missing data.');
      }

      // استرجاع cartItems باستخدام cartId من Firestore
      const cartDocRef = doc(db, 'carts', cartId);
      const cartDoc = await getDoc(cartDocRef);

      if (!cartDoc.exists()) {
        return res.status(400).send('Cart not found.');
      }

      const cartItems = cartDoc.data().products;

      if (!cartItems || cartItems.length === 0) {
        return res.status(400).send('No products found in cart.');
      }

      // تسجيل الطلب في Firestore
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

      // تحديث المخزون والمبيعات لكل منتج
      const batch = writeBatch(db);
      cartItems.forEach((item) => {
        const productRef = doc(db, "products", String(item.id));
        batch.update(productRef, {
          stock: increment(-item.quantity),
          sales: increment(item.quantity),
        });
      });

      await batch.commit();

      // حذف السلة بعد الدفع الناجح
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

// تشغيل السيرفر
app.listen(4242, () => console.log('Backend running on port 4242'));

app.get('/', (req, res) => {
  res.send('Backend is working');
});
