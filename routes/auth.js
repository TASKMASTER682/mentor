import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User.js';
import { isDisposableEmail, isValidIndianState } from '../utils/authValidation.js';
import { emailService } from '../services/emailService.js';

const router = express.Router();

const generateToken = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET || 'upsc_secret_key', { expiresIn: '30d' });
const VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth' });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, state } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    
    if (!name || !normalizedEmail || !password || !state) {
      return res.status(400).json({ error: 'Name, email, password, and state are required' });
    }

    if (isDisposableEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Disposable email addresses are not allowed' });
    }

    if (!isValidIndianState(state)) {
      return res.status(400).json({ error: 'Please select a valid Indian state/UT' });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    const existingIsVerified = existingUser && existingUser.emailVerified !== false;
    if (existingIsVerified) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + VERIFICATION_EXPIRY_MS);
    const trimmedState = state.trim();

    let savedUser;
    if (existingUser) {
      existingUser.name = name.trim();
      existingUser.password = password;
      existingUser.profile = { ...(existingUser.profile?.toObject?.() || existingUser.profile || {}), state: trimmedState };
      existingUser.emailVerificationToken = verificationToken;
      existingUser.emailVerificationExpires = verificationExpires;
      existingUser.emailVerified = false;
      savedUser = await existingUser.save();
    } else {
      const user = new User({
        name: name.trim(),
        email: normalizedEmail,
        password,
        emailVerified: false,
        emailVerificationToken: verificationToken,
        emailVerificationExpires: verificationExpires,
        profile: { state: trimmedState }
      });
      savedUser = await user.save();
    }

    const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verificationToken}`;
    await emailService.sendVerificationEmail({
      toEmail: savedUser.email,
      name: savedUser.name,
      verificationLink,
    });

    res.status(201).json({
      requiresEmailVerification: true,
      message: 'Verification link sent to your email. Please verify before login.',
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message || 'Registration failed' });
  }
});

router.get('/verify-email', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    const user = await User.findOne({ emailVerificationToken: token });
    if (!user) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    if (!user.emailVerificationExpires || user.emailVerificationExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Verification link expired. Register again to get a new link.' });
    }

    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const authToken = generateToken(user._id);
    return res.redirect(`${frontendUrl}/login?verified=1&token=${encodeURIComponent(authToken)}`);
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).json({ error: err.message || 'Email verification failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (isDisposableEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Disposable email addresses are not allowed' });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.emailVerified === false) {
      return res.status(403).json({ error: 'Email not verified. Please verify your email first.' });
    }

    const token = generateToken(user._id);
    const responseData = {
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profile: user.profile,
        stats: user.stats
      }
    };
    res.json(responseData);
  } catch (err) {
    console.error('Login error - Full error:', err);
    console.error('Login error - Stack:', err.stack);
    res.status(500).json({ error: err.message || 'Login failed', details: err.toString() });
  }
});

export default router;

