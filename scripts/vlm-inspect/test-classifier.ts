// test-classifier.ts — run the keyword classifier against the baseline
// scenario prompts to find misroutes.
import { classifyIntent } from '../../src/lib/agent/classifier';

const prompts = [
  "Create an 'Account Settings' panel with two labeled input fields: Display Name and Email Address.",
  "Add a primary 'Save Changes' button and a ghost-style 'Cancel' button below the fields.",
  "Add a 'Notifications' section below with two toggle rows - 'Email updates' and 'Product news' - both shown switched on.",
  "Create a user profile card: a circular avatar placeholder, the name 'Maya Chen', the job title 'Product Designer', and a row of three stats - 128 Followers, 342 Following, 56 Posts.",
  "Create a kanban board with three columns - To Do, In Progress, Done - each column containing two task cards with a short realistic title and a small colored tag.",
  "Create a card containing a bar chart titled 'Monthly Revenue' with six bars for Jan to Jun showing 12k, 18k, 15k, 24k, 29k and 33k, with value labels above each bar.",
  "Create a website top navigation bar for a site called 'Acme': the logo text 'Acme' on the left, the links Home, Products, Pricing and About in the middle, and a 'Sign Up' button on the right.",
  "Create a pricing card for the 'Pro' plan at $12 per month: the plan name, the price, a list of 4 realistic features, and a 'Choose Pro' button.",
  "Turn it into a row of three pricing cards side by side: Starter at $0, Pro at $12 with a 'Popular' badge and a highlighted border, and Team at $49.",
  'Make all three cards the same height with consistent padding, and center the plan names.',
];

for (const p of prompts) {
  const r = await classifyIntent({ prompt: p, canvasShapeCount: 0 });
  console.log(`${r.category.padEnd(10)} conf=${r.confidence.toFixed(2)} plan=${r.recommendPlan} | ${p.slice(0, 70)}`);
}
