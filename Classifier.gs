/**
 * Classifier.gs — AI-powered email classification + extraction.
 *
 * A single Claude call per email returns:
 *   - whether it's a job application email
 *   - company, role, status
 *   - source, salary range, location, career site, notes
 *   - confidence score
 *
 * No regex rules. The Gmail search query in Code.gs still pre-filters
 * the inbox to job-shaped emails so we don't pay to classify spam.
 */

/**
 * Main entry point. Returns a unified result object combining
 * classification and extraction. Code.gs uses this directly.
 */
function classifyAndExtract({ subject, from, body }) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    Logger.log('ANTHROPIC_API_KEY missing from Script Properties.');
    return emptyResult('no-api-key');
  }

  const prompt = buildPrompt({ subject, from, body });

  let response;
  try {
    response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    Logger.log('Anthropic API request threw: ' + err.message);
    return emptyResult('api-error');
  }

  const code = response.getResponseCode();
  if (code !== 200) {
    Logger.log('Anthropic API ' + code + ': ' + response.getContentText().slice(0, 300));
    return emptyResult('api-' + code);
  }

  const data = JSON.parse(response.getContentText());
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    Logger.log('LLM returned non-JSON: ' + cleaned.slice(0, 300));
    return emptyResult('parse-error');
  }

  // Normalize the response shape — defend against missing keys
  return {
    method: 'llm',
    is_application: Boolean(parsed.is_application),
    company: String(parsed.company || '').slice(0, 100),
    role: String(parsed.role || '').slice(0, 100),
    status: validStatus(parsed.status),
    confidence: clampConfidence(parsed.confidence),
    source: String(parsed.source || '').slice(0, 60),
    salaryRange: String(parsed.salary_range || '').slice(0, 60),
    location: String(parsed.location || '').slice(0, 80),
    careerSite: String(parsed.career_site || '').slice(0, 200),
    notes: String(parsed.notes || '').slice(0, 200),
  };
}

/**
 * Build the prompt. Kept as a separate function so it's easy to tune.
 */
function buildPrompt({ subject, from, body }) {
  return [
    'You are analyzing an email to determine whether it relates to a job application the recipient submitted, and to extract structured details.',
    '',
    'EMAIL',
    'From: ' + from,
    'Subject: ' + subject,
    'Body (first 2000 chars):',
    (body || '').slice(0, 2000),
    '',
    'Respond with ONLY a JSON object (no markdown fences, no prose) matching this exact schema:',
    '',
    '{',
    '  "is_application": boolean,',
    '  "confidence": number between 0 and 1,',
    '  "company": string,',
    '  "role": string,',
    '  "status": "Applied" | "Application Reviewed" | "Assessment" | "Interview Scheduled" | "Interview Completed" | "Offer" | "Accepted" | "Rejected" | "Withdrawn" | "",',
    '  "source": string,',
    '  "salary_range": string,',
    '  "location": string,',
    '  "career_site": string,',
    '  "notes": string',
    '}',
    '',
    'CLASSIFICATION RULES',
    '- is_application=true ONLY when the recipient applied for or is in the process of interviewing for a specific role.',
    '- is_application=false for: job board newsletters, weekly digests, recruiter cold outreach where the recipient never applied, LinkedIn alerts, marketing emails, and account confirmations from job sites.',
    '- Emails may be in English or Spanish (or other languages). The status value you return must always be one of the English enum values listed above, regardless of email language. Other fields (company, role, location, notes) should be returned in whatever language the email used — do not translate them.',
    '- Set confidence < 0.5 when uncertain. Below 0.6, the row will be skipped.',
    '',
    'STATUS GUIDE',
    '- Applied: initial confirmation that an application was received',
    '- Application Reviewed: a recruiter is reviewing, has reached out, or invites a screening call',
    '- Assessment: coding challenge, take-home, technical test, or skills assessment',
    '- Interview Scheduled: a specific interview has been arranged',
    '- Interview Completed: post-interview follow-up or "we are still deciding"',
    '- Offer: formal offer extended',
    '- Accepted: candidate accepted the offer',
    '- Rejected: candidate was rejected ("unfortunately", "other candidates", "won\'t be moving forward")',
    '- Withdrawn: candidate withdrew',
    '',
    'EXTRACTION RULES',
    '- company: the hiring company, NOT the ATS (Greenhouse, Lever, Workday, etc.). Look for "on behalf of X" patterns or the body content.',
    '- role: the specific job title applied for. Omit seniority qualifiers only if not stated.',
    '- source: how the application was submitted — "LinkedIn", "Indeed", "Referral", "Direct" (company career page), "Glassdoor", "Wellfound", etc. Empty string if unclear.',
    '- salary_range: as written if present (e.g. "$120K - $150K", "£80,000 - £100,000"). Empty if not mentioned.',
    '- location: "Remote", "Hybrid", or a city/region. Empty if not mentioned.',
    '- career_site: the company\'s careers URL if present in the email body. Empty if not present — do NOT guess.',
    '- notes: a one-line summary of what this specific email communicates (max 150 chars). Examples: "Recruiter scheduling screening call for next week", "Take-home assignment sent, due in 5 days", "Final round scheduled with the engineering team".',
    '',
    'If is_application is false, set all other string fields to empty strings and status to "".',
  ].join('\n');
}

// ---------------- Helpers ----------------

const VALID_STATUSES = [
  'Applied', 'Application Reviewed', 'Assessment',
  'Interview Scheduled', 'Interview Completed',
  'Offer', 'Accepted', 'Rejected', 'Withdrawn',
];

function validStatus(s) {
  if (!s || typeof s !== 'string') return '';
  return VALID_STATUSES.indexOf(s) >= 0 ? s : '';
}

function clampConfidence(c) {
  const n = Number(c);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function emptyResult(method) {
  return {
    method: method,
    is_application: false,
    company: '', role: '', status: '',
    confidence: 0,
    source: '', salaryRange: '', location: '',
    careerSite: '', notes: '',
  };
}
