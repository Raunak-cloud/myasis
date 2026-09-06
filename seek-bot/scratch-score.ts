process.env.KEYWORDS = 'Pharmacy assistant, Lab assistant, Clinical research assistant, retail assistant, customer service, medical receptionist, Cafe, Floor staff';
process.env.MIN_SALARY = '45000';
process.env.ONSITE_CITY = 'Sydney';
const { titleFit } = await import('./src/scoring.js');

const titles = [
  'Pharmacy Assistant',
  'Retail Assistant',
  'Clinical Research Assistant',
  'Medical Receptionist',
  'Customer Service Officer',
  'Cafe All Rounder',
  'Casual Floor Staff',
  'Senior Software Engineer',
  'Registered Nurse',
];
for (const t of titles) console.log(String(titleFit(t)).padStart(2), '/15  ', t);
