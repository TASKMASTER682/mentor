const INDIAN_STATES_AND_UT = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  '20minutemail.com',
  'dispostable.com',
  'fakeinbox.com',
  'guerrillamail.com',
  'maildrop.cc',
  'mailinator.com',
  'mintemail.com',
  'mytemp.email',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.plus',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

const getEmailDomain = (email = '') => String(email).trim().toLowerCase().split('@')[1] || '';

export const isDisposableEmail = (email = '') => {
  const domain = getEmailDomain(email);
  return !!domain && DISPOSABLE_EMAIL_DOMAINS.has(domain);
};

export const isValidIndianState = (state = '') => {
  const normalized = String(state).trim().toLowerCase();
  if (!normalized) return false;
  return INDIAN_STATES_AND_UT.some((item) => item.toLowerCase() === normalized);
};

export const INDIAN_STATE_OPTIONS = INDIAN_STATES_AND_UT;
