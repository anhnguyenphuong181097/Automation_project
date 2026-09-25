import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.DEEPSEEK_API_KEY;
const prompt = process.argv.slice(2).join(' ') || 'Explain what this Playwright project does.';

if (!apiKey) {
  console.error('Missing DEEPSEEK_API_KEY. Add it to .env or set it in PowerShell.');
  process.exit(1);
}

const response = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: prompt }
    ]
  })
});

const data = await response.json();

if (!response.ok) {
  console.error(`DeepSeek API error (${response.status}): ${data.error?.message || JSON.stringify(data)}`);
  process.exit(1);
}

console.log(data.choices[0].message.content);