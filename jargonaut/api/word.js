export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { exclude = [] } = req.body

  const excludeBlock = exclude.length > 0
    ? `\n\nHARD CONSTRAINT — these words have already been shown and must never appear again:\n${exclude.join(', ')}\n\nPick something completely different.`
    : ''

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Generate a word for a workplace game where players try to naturally weave an unusual word into business conversation without colleagues noticing.

Criteria:
- Unusual but real English word — not everyday vocab, but not archaic or obscure
- Pronounceable by someone who has never seen it
- Flexible enough to use naturally in a business meeting without sounding bizarre
- Right register: like sanguine, circumspect, ebullient, obfuscate, pernicious, fastidious, propitious, truculent, mellifluous${excludeBlock}

Return ONLY valid JSON, no markdown fences, no preamble, no extra text:
{
  "word": "the word (lowercase)",
  "syllables": "SYL-uh-blz (capital letters = stressed syllable)",
  "ipa": "(/ˌsɪl.ə.bəlz/)",
  "pronunciationTips": [
    {"syllable": "SYL", "hint": "like \\"skill\\" (stressed)"},
    {"syllable": "uh", "hint": "quick and soft, like \\"uh\\""},
    {"syllable": "blz", "hint": "ends like \\"bells\\""}
  ],
  "definition": "Concise plain-English definition (1 sentence)",
  "businessUsage": "A realistic natural-sounding sentence someone might actually say in a work meeting"
}`
        }]
      })
    })

    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: text })
    }

    const data = await response.json()
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('')
    const wordData = JSON.parse(txt.replace(/```json|```/g, '').trim())

    return res.status(200).json(wordData)
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}
