# ConflictIntel Hub - Technical Specification

## Project Overview
- **Name**: ConflictIntel Hub
- **Type**: AI-powered geopolitical intelligence platform
- **Core**: Interactive world map + AI chat with RAG for conflict analysis
- **Target Users**: Traders, analysts, journalists, students, travelers, NGOs, enterprises

## Tech Stack
- **Frontend**: Next.js 14 (App Router)
- **Backend**: Express.js
- **Database**: MongoDB with Mongoose
- **Auth**: JWT + bcryptjs
- **AI**: LangChain + Groq/OpenRouter
- **Maps**: MapLibre GL JS + deck.gl
- **Real-time**: Socket.io
- **Payments**: Stripe (mock - wired later)

## Project Structure
```
conflict-intel-hub/
├── backend/
│   ├── config/
│   │   └── db.js
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── conflictController.js
│   │   ├── chatController.js
│   │   ├── alertController.js
│   │   └── riskController.js
│   ├── middleware/
│   │   ├── auth.js
│   │   └── rateLimiter.js
│   ├── models/
│   │   ├── User.js
│   │   ├── ConflictEvent.js
│   │   ├── ChatMessage.js
│   │   ├── Alert.js
│   │   ├── RiskPrediction.js
│   │   └── Subscription.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── conflicts.js
│   │   ├── chat.js
│   │   ├── alerts.js
│   │   └── risks.js
│   ├── services/
│   │   ├── acledService.js
│   │   ├── gdeltService.js
│   │   ├── ragService.js
│   │   ├── llmService.js
│   │   ├── riskScoringService.js
│   │   └── alertService.js
│   ├── utils/
│   │   └── helpers.js
│   ├── server.js
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.js (landing)
│   │   │   ├── layout.js
│   │   │   ├── globals.css
│   │   │   ├── (auth)/
│   │   │   │   ├── login/page.js
│   │   │   │   └── register/page.js
│   │   │   ├── (dashboard)/
│   │   │   │   ├── layout.js
│   │   │   │   ├── page.js (dashboard)
│   │   │   │   ├── map/page.js
│   │   │   │   ├── chat/page.js
│   │   │   │   ├── alerts/page.js
│   │   │   │   └── risks/page.js
│   │   │   └── pricing/page.js
│   │   ├── components/
│   │ ui/
│   │   │   ├── map/
│   │   │   │   ├──   ├── chat/
│   │   │   └── layout/
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── context/
│   │   └── types/
│   ├── public/
│   ├── next.config.js
│   └── package.json
├── .env.example
└── docker-compose.yml
```

## Database Schema

### User
```javascript
{
  _id: ObjectId,
  email: String (unique, required),
  password: String (hashed),
  name: String,
  avatar: String,
  role: Enum ['user', 'admin', 'enterprise'],
  subscription: {
    tier: Enum ['free', 'pro', 'enterprise'],
    stripeCustomerId: String,
    stripeSubscriptionId: String,
    status: Enum ['active', 'cancelled', 'past_due', 'trialing'],
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    queriesUsed: Number,
    queriesLimit: Number
  },
  watchlist: [{
    country: String,
    conflictTypes: [String]
  }],
  preferences: {
    darkMode: Boolean,
    notifications: Boolean,
    emailAlerts: Boolean
  },
  referralCode: String,
  referredBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

### ConflictEvent (ACLED data)
```javascript
{
  _id: ObjectId,
  eventId: String (unique, ACLED ID),
  source: String (ACLED/GDELT),
  eventDate: Date,
  year: Number,
  month: Number,
  day: Number,
  country: String,
  countryCode: String,
  admin1: String,
  admin2: String,
  location: {
    type: Point,
    coordinates: [Number] // [lng, lat]
  },
  latitude: Number,
  longitude: Number,
  geoPrecision: String,
  eventType: String,
  subEventType: String,
  actor1: String,
  actor2: String,
  inter1: Boolean,
  inter2: Boolean,
  interaction: Number,
  fatalities: Number,
  notes: String,
  tags: [String],
  economicImpact: {
    commodityAffected: String,
    impactScore: Number,
    description: String
  },
  riskScore: Number,
  createdAt: Date,
  updatedAt: Date
}
```

### ChatMessage
```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  role: Enum ['user', 'assistant'],
  content: String,
  sources: [{
    eventId: ObjectId,
    eventId: String,
    country: String,
    eventType: String,
    fatalities: Number,
    date: Date,
    excerpt: String,
    relevance: Number
  }],
  tokenUsage: Number,
  queryType: Enum ['brief', 'analysis', 'prediction', 'economic'],
  createdAt: Date
}
```

### Alert
```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  type: Enum ['risk_spike', 'new_conflict', 'fatality_threshold', 'economic_impact', 'custom'],
  title: String,
  message: String,
  region: String,
  countries: [String],
  conditions: {
    minFatalities: Number,
    minRiskScore: Number,
    countries: [String],
    eventTypes: [String]
  },
  severity: Enum ['low', 'medium', 'high', 'critical'],
  isRead: Boolean,
  isSent: Boolean,
  sentAt: Date,
  createdAt: Date
}
```

### RiskPrediction
```javascript
{
  _id: ObjectId,
  region: String,
  country: String,
  countryCode: String,
  conflictType: String,
  riskScore: Number, // 1-100
  riskLevel: Enum ['low', 'medium', 'high', 'critical'],
  probability30Day: Number,
  probability90Day: Number,
  triggers: [{
    name: String,
    description: String,
    source: String,
    weight: Number
  }],
  economicImpact: {
    oilRisk: Number,
    commodityRisk: Number,
    shippingRisk: Number,
    description: String
  },
  lastUpdated: Date,
  nextUpdate: Date,
  createdAt: Date
}
```

### DailyBrief
```javascript
{
  _id: ObjectId,
  date: Date,
  title: String,
  summary: String,
  keyEvents: [{
    country: String,
    eventType: String,
    fatalities: Number,
    description: String
  }],
  economicImpact: String,
  riskRadar: [{
    region: String,
    riskScore: Number
  }],
  generatedAt: Date
}
```

## API Endpoints

### Auth
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- POST /api/auth/forgot-password
- POST /api/auth/reset-password

### Conflicts
- GET /api/conflicts (with filters: country, eventType, dateRange, severity)
- GET /api/conflicts/:id
- GET /api/conflicts/stats (aggregated stats)
- GET /api/conflicts/heatmap-data

### Chat
- POST /api/chat/query
- GET /api/chat/history
- GET /api/chat/brief

### Alerts
- GET /api/alerts
- POST /api/alerts
- PUT /api/alerts/:id
- DELETE /api/alerts/:id
- PUT /api/alerts/:id/read

### Risks
- GET /api/risks (list risk predictions)
- GET /api/risks/:id
- GET /api/risks/radar

### Subscriptions (Stripe - mock)
- POST /api/subscriptions/create-checkout
- POST /api/subscriptions/portal
- POST /api/subscriptions/webhook

## MVP Features

### 1. Interactive Global Conflict Map
- MapLibre GL JS with OpenStreetMap tiles
- Conflict markers by severity (color-coded)
- Filters: country, event type, date range, fatalities
- Cluster view for high-density areas
- Click for event details popup
- Heatmap overlay toggle

### 2. AI Intelligence Chat
- Natural language queries
- Source citations with links
- Daily global briefs
- Economic impact analysis
- RAG with semantic search

### 3. Risk Radar
- Auto-generated conflict predictions
- Risk scores (1-100)
- Triggers with sources
- Economic impact forecasts
- Probability estimates
- Sorted by risk level

### 4. Alerts System
- Custom alert rules
- Real-time notifications
- Email alerts (mock)
- Watchlist countries

### 5. Dashboard
- Personalized view
- Watchlist overview
- Recent events
- Risk summary

### 6. Freemium Model
- Free: 5 queries/day, basic map, public briefs
- Pro: Unlimited queries, alerts, export, ad-free
- Enterprise: API access, white-label, custom feeds

## Seed Data
Regions with active conflicts:
1. Ukraine (since 2022)
2. Middle East (Israel-Palestine, etc.)
3. South China Sea
4. Sudan
5. Myanmar

## Environment Variables
```
# Backend
MONGODB_URI=
JWT_SECRET=
JWT_EXPIRE=
GROQ_API_KEY=
OPENROUTER_API_KEY=

# Frontend
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_WS_URL=
```
