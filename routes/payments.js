import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { Course } from '../models/Course.js';
import UserCourseEnrollment from '../models/UserCourseEnrollment.js';
import { SystemSettings } from '../models/SystemSettings.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Helper to get Razorpay instance with latest settings
const getRazorpayInstance = async () => {
  const settings = await SystemSettings.findOne();
  if (!settings || !settings.razorpayKeyId || !settings.razorpayKeySecret) {
    throw new Error('Razorpay configuration missing');
  }
  return new Razorpay({
    key_id: settings.razorpayKeyId,
    key_secret: settings.razorpayKeySecret,
  });
};

// Create Razorpay Order
router.post('/create-order', authenticate, async (req, res) => {
  try {
    const { courseId } = req.body;
    const course = await Course.findById(courseId);
    
    if (!course) return res.status(404).json({ error: 'Course not found' });

    // Calculate effective price
    let amount = course.price;
    if (course.discountPrice && (!course.discountExpiry || new Date(course.discountExpiry) > new Date())) {
      amount = course.discountPrice;
    }

    if (amount <= 0) {
      // Free course enrollment
      await UserCourseEnrollment.create({
        userId: req.user.id,
        courseId: course._id,
        status: 'completed',
        pricePaid: 0
      });
      return res.json({ success: true, message: 'Enrolled in free course' });
    }

    const rzp = await getRazorpayInstance();
    const options = {
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: `receipt_${courseId}_${req.user.id}_${Date.now()}`,
    };

    const order = await rzp.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error('Order creation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify Payment Signature
router.post('/verify-payment', authenticate, async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature,
      courseId 
    } = req.body;

    const settings = await SystemSettings.findOne();
    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac("sha256", settings.razorpayKeySecret)
      .update(sign.toString())
      .digest("hex");

    if (razorpay_signature === expectedSign) {
      // Payment verified
      const course = await Course.findById(courseId);
      let amount = course.price;
      if (course.discountPrice && (!course.discountExpiry || new Date(course.discountExpiry) > new Date())) {
        amount = course.discountPrice;
      }

      await UserCourseEnrollment.create({
        userId: req.user.id,
        courseId,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        status: 'completed',
        pricePaid: amount
      });

      res.json({ success: true, message: "Payment verified and enrollment completed" });
    } else {
      res.status(400).json({ error: "Invalid payment signature" });
    }
  } catch (error) {
    console.error('Verification failed:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
