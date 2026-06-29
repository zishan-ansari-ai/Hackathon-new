/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';

// Initialize Gemini client lazily to avoid crashing on startup if key is missing
let aiClient: any = null;

function getAIClient() {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== 'MY_GEMINI_API_KEY' && key.trim() !== '') {
      aiClient = new GoogleGenAI({ apiKey: key });
    }
  }
  return aiClient;
}

export interface ValidatedAITriage {
  category: "POTHOLE" | "ROAD_DAMAGE" | "BROKEN_STREETLIGHT" | "ELECTRICAL_HAZARD" | "WATER_LEAKAGE" | "DAMAGED_PIPE" | "DRAINAGE_ISSUE" | "GARBAGE_OVERFLOW" | "ILLEGAL_DUMPING" | "WASTE_MANAGEMENT" | "OTHER" | "UNCLEAR";
  confidence: number; // 0 to 1
  severity: number; // 1 to 5
  safetyRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  evidenceQuality: "POOR" | "FAIR" | "GOOD" | "EXCELLENT";
  suggestedDepartmentId: "roads" | "electrical" | "water" | "sanitation" | "general_admin";
  summary: string;
  observedConditions: string[];
  requiresHumanReview: boolean;
  humanReviewReason: string | null;
  sensitiveContentFlag: boolean;
}

/**
 * Local rule-based fallback analyzer that matches the exact schema requested.
 */
export function runFallbackTriage(description: string, submittedCategory: string | null): ValidatedAITriage {
  const text = description.toLowerCase();
  
  let category: ValidatedAITriage['category'] = (submittedCategory as any) || 'OTHER';
  let safetyRisk: ValidatedAITriage['safetyRisk'] = 'MEDIUM';
  let severity = 3;
  let suggestedDepartmentId: ValidatedAITriage['suggestedDepartmentId'] = 'general_admin';
  let summary = 'Standard municipal request processed by secure fallback analyzer.';
  const observedConditions: string[] = [];

  // Categorization & Routing Rules
  if (text.includes('pothole') || text.includes('crater') || text.includes('hole in road') || text.includes('asphalt')) {
    category = 'POTHOLE';
    suggestedDepartmentId = 'roads';
    summary = 'Report identifies a deep pothole or road surface hole.';
    observedConditions.push('Visible asphalt cavity', 'Potential vehicle damage risk');
    severity = 3;
  } else if (text.includes('guardrail') || text.includes('sidewalk') || text.includes('road damage') || text.includes('pavement')) {
    category = 'ROAD_DAMAGE';
    suggestedDepartmentId = 'roads';
    summary = 'Report identifies structural damage to sidewalks or public roadway perimeter.';
    observedConditions.push('Structural degradation', 'Pedestrian hazard');
    severity = 2;
  } else if (text.includes('streetlight') || text.includes('lamp') || text.includes('no light') || text.includes('dark street')) {
    category = 'BROKEN_STREETLIGHT';
    suggestedDepartmentId = 'electrical';
    summary = 'Report identifies a non-functioning streetlight leading to dark areas.';
    observedConditions.push('No illumination', 'Petty safety concern at night');
    severity = 2;
    safetyRisk = 'LOW';
  } else if (text.includes('wire') || text.includes('transformer') || text.includes('spark') || text.includes('shock') || text.includes('electricity') || text.includes('electrical')) {
    category = 'ELECTRICAL_HAZARD';
    suggestedDepartmentId = 'electrical';
    summary = 'Report identifies a severe electrical hazard with exposed or sparking wires.';
    observedConditions.push('Exposed wiring', 'Active sparking risk', 'Imminent shock hazard');
    severity = 5;
    safetyRisk = 'CRITICAL';
  } else if (text.includes('water leakage') || text.includes('leak') || text.includes('gush') || text.includes('water running') || text.includes('flooding yard')) {
    category = 'WATER_LEAKAGE';
    suggestedDepartmentId = 'water';
    summary = 'Report identifies fresh water running or leaking extensively onto sidewalks or roadways.';
    observedConditions.push('Uncontrolled water flow', 'Water wastage', 'Pavement erosion risk');
    severity = 4;
    safetyRisk = 'HIGH';
  } else if (text.includes('pipe') || text.includes('main line') || text.includes('burst')) {
    category = 'DAMAGED_PIPE';
    suggestedDepartmentId = 'water';
    summary = 'Report identifies a ruptured pipe or main line burst.';
    observedConditions.push('Damaged public utility pipe', 'Heavy flow and pooling');
    severity = 4;
    safetyRisk = 'HIGH';
  } else if (text.includes('drain') || text.includes('clogged') || text.includes('block') || text.includes('flooded street') || text.includes('puddle')) {
    category = 'DRAINAGE_ISSUE';
    suggestedDepartmentId = 'water';
    summary = 'Report identifies a blocked storm drain causing water accumulation.';
    observedConditions.push('Clogged drainage grate', 'Standing water accumulation');
    severity = 3;
    safetyRisk = 'MEDIUM';
  } else if (text.includes('garbage overflow') || text.includes('bin full') || text.includes('trash') || text.includes('overflowing')) {
    category = 'GARBAGE_OVERFLOW';
    suggestedDepartmentId = 'sanitation';
    summary = 'Report identifies an overflowing public refuse bin causing litter clutter.';
    observedConditions.push('Overflowing refuse bins', 'Scattered organic debris');
    severity = 2;
    safetyRisk = 'LOW';
  } else if (text.includes('dump') || text.includes('illegal dumping') || text.includes('asbestos') || text.includes('construction waste') || text.includes('mattress')) {
    category = 'ILLEGAL_DUMPING';
    suggestedDepartmentId = 'sanitation';
    summary = 'Report identifies commercial or bulky construction waste dumped illegally.';
    observedConditions.push('Unlicensed bulky deposition', 'Obstruction of public path');
    severity = 4;
    safetyRisk = 'HIGH';
  } else if (text.includes('dead animal') || text.includes('refuse') || text.includes('litter')) {
    category = 'WASTE_MANAGEMENT';
    suggestedDepartmentId = 'sanitation';
    summary = 'Report identifies general littering or sanitation waste requiring cleanup.';
    observedConditions.push('Refuse on public display');
    severity = 2;
    safetyRisk = 'LOW';
  }

  // Location Sensitivity adjust points & text check
  if (text.includes('school') || text.includes('child') || text.includes('kid') || text.includes('student') || text.includes('elementary')) {
    safetyRisk = 'CRITICAL';
    severity = Math.min(severity + 1, 5);
    summary += ' Escalated due to school vicinity.';
    observedConditions.push('Near educational facility', 'High risk to schoolchildren');
  } else if (text.includes('hospital') || text.includes('emergency') || text.includes('highway') || text.includes('main road') || text.includes('crossing')) {
    safetyRisk = safetyRisk === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
    severity = Math.min(severity + 1, 5);
    summary += ' Escalated due to high-footfall crossing or hospital vicinity.';
    observedConditions.push('High-traffic crossing or healthcare zone');
  }

  // If description matching didn't yield a department, map from category
  if (suggestedDepartmentId === 'general_admin' && category) {
    if (category === 'POTHOLE' || category === 'ROAD_DAMAGE') {
      suggestedDepartmentId = 'roads';
    } else if (category === 'BROKEN_STREETLIGHT' || category === 'ELECTRICAL_HAZARD') {
      suggestedDepartmentId = 'electrical';
    } else if (category === 'WATER_LEAKAGE' || category === 'DAMAGED_PIPE' || category === 'DRAINAGE_ISSUE') {
      suggestedDepartmentId = 'water';
    } else if (category === 'GARBAGE_OVERFLOW' || category === 'ILLEGAL_DUMPING' || category === 'WASTE_MANAGEMENT') {
      suggestedDepartmentId = 'sanitation';
    }
  }

  // Validate Evidence Quality based on length or description detail
  let evidenceQuality: ValidatedAITriage['evidenceQuality'] = 'FAIR';
  if (description.length > 100) {
    evidenceQuality = 'EXCELLENT';
  } else if (description.length > 50) {
    evidenceQuality = 'GOOD';
  } else if (description.length < 20) {
    evidenceQuality = 'POOR';
  }

  return {
    category,
    confidence: 0.85,
    severity,
    safetyRisk,
    evidenceQuality,
    suggestedDepartmentId,
    summary,
    observedConditions: observedConditions.length > 0 ? observedConditions : ['Report contains plain text details'],
    requiresHumanReview: true,
    humanReviewReason: 'Mandatory municipal quality audit checks',
    sensitiveContentFlag: false
  };
}

export async function analyzeIncidentReport(
  description: string,
  submittedCategory: string | null,
  mediaUrls: string[] = [],
  latitude?: number,
  longitude?: number
): Promise<ValidatedAITriage> {
  const client = getAIClient();
  if (!client) {
    console.log('[CivicResolve AI] Using server-side rule-based analysis (Gemini Key not configured or empty)');
    return runFallbackTriage(description, submittedCategory);
  }

  try {
    const prompt = `
You are the AI triage assistant for a municipal workflow software application named "CivicResolve AI".
Analyze the citizen report and output a structured JSON response indicating the recommended classification, routing, and urgency.

Report Description:
"${description}"

User Submitted Category: ${submittedCategory || "None"}
Location (Approx): Lat ${latitude || 'N/A'}, Lng ${longitude || 'N/A'}
Media Attachments: ${mediaUrls.join(', ') || 'None'}

Please choose the category strictly from this list of supported categories:
- POTHOLE
- ROAD_DAMAGE
- BROKEN_STREETLIGHT
- ELECTRICAL_HAZARD
- WATER_LEAKAGE
- DAMAGED_PIPE
- DRAINAGE_ISSUE
- GARBAGE_OVERFLOW
- ILLEGAL_DUMPING
- WASTE_MANAGEMENT
- OTHER
- UNCLEAR

Please choose the recommended department ID strictly from:
- roads
- electrical
- water
- sanitation
- general_admin

Choose the safetyRisk strictly from:
- LOW
- MEDIUM
- HIGH
- CRITICAL

Choose evidenceQuality strictly from:
- POOR
- FAIR
- GOOD
- EXCELLENT

The JSON schema must be exactly:
{
  "category": "POTHOLE | ROAD_DAMAGE | BROKEN_STREETLIGHT | ELECTRICAL_HAZARD | WATER_LEAKAGE | DAMAGED_PIPE | DRAINAGE_ISSUE | GARBAGE_OVERFLOW | ILLEGAL_DUMPING | WASTE_MANAGEMENT | OTHER | UNCLEAR",
  "confidence": number (float between 0.0 and 1.0),
  "severity": number (integer between 1 and 5),
  "safetyRisk": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "evidenceQuality": "POOR" | "FAIR" | "GOOD" | "EXCELLENT",
  "suggestedDepartmentId": "roads" | "electrical" | "water" | "sanitation" | "general_admin",
  "summary": string,
  "observedConditions": [string, string, ...],
  "requiresHumanReview": boolean,
  "humanReviewReason": string | null,
  "sensitiveContentFlag": boolean
}

Ensure you output ONLY the valid JSON block without any markdown formatting around it, or formatting tags. Do not put markdown code blocks around it.
`;

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const responseText = response.text || '';
    // Clean JSON response
    const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(jsonStr);

    // Schema Validation & Fail Safe
    const categories = ["POTHOLE", "ROAD_DAMAGE", "BROKEN_STREETLIGHT", "ELECTRICAL_HAZARD", "WATER_LEAKAGE", "DAMAGED_PIPE", "DRAINAGE_ISSUE", "GARBAGE_OVERFLOW", "ILLEGAL_DUMPING", "WASTE_MANAGEMENT", "OTHER", "UNCLEAR"];
    const departments = ["roads", "electrical", "water", "sanitation", "general_admin"];
    const safetyRisks = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const evidenceQualities = ["POOR", "FAIR", "GOOD", "EXCELLENT"];

    const rawDept = typeof result.suggestedDepartmentId === 'string'
      ? result.suggestedDepartmentId.trim().toLowerCase()
      : '';
    const rawCat = typeof result.category === 'string'
      ? result.category.trim().toUpperCase()
      : '';

    const validatedCategory = categories.includes(rawCat) ? rawCat : "UNCLEAR";
    let validatedDept = departments.includes(rawDept) ? rawDept as any : "general_admin";

    // Auto-map if department is general_admin but we have a specific category
    if (validatedDept === 'general_admin' && validatedCategory) {
      if (validatedCategory === 'POTHOLE' || validatedCategory === 'ROAD_DAMAGE') {
        validatedDept = 'roads';
      } else if (validatedCategory === 'BROKEN_STREETLIGHT' || validatedCategory === 'ELECTRICAL_HAZARD') {
        validatedDept = 'electrical';
      } else if (validatedCategory === 'WATER_LEAKAGE' || validatedCategory === 'DAMAGED_PIPE' || validatedCategory === 'DRAINAGE_ISSUE') {
        validatedDept = 'water';
      } else if (validatedCategory === 'GARBAGE_OVERFLOW' || validatedCategory === 'ILLEGAL_DUMPING' || validatedCategory === 'WASTE_MANAGEMENT') {
        validatedDept = 'sanitation';
      }
    }

    const validatedRisk = safetyRisks.includes(result.safetyRisk) ? result.safetyRisk : "MEDIUM";
    const validatedEvidence = evidenceQualities.includes(result.evidenceQuality) ? result.evidenceQuality : "FAIR";

    return {
      category: validatedCategory,
      confidence: typeof result.confidence === 'number' && result.confidence >= 0 && result.confidence <= 1 ? result.confidence : 0.70,
      severity: typeof result.severity === 'number' && result.severity >= 1 && result.severity <= 5 ? result.severity : 3,
      safetyRisk: validatedRisk,
      evidenceQuality: validatedEvidence,
      suggestedDepartmentId: validatedDept,
      summary: result.summary || 'Summary compiled by secure AI agent.',
      observedConditions: Array.isArray(result.observedConditions) ? result.observedConditions : ['Visual indicators analyzed.'],
      requiresHumanReview: typeof result.requiresHumanReview === 'boolean' ? result.requiresHumanReview : true,
      humanReviewReason: result.humanReviewReason || 'Standard municipal queue workflow check.',
      sensitiveContentFlag: typeof result.sensitiveContentFlag === 'boolean' ? result.sensitiveContentFlag : false
    };
  } catch (error) {
    console.error('[CivicResolve AI] Error calling Gemini API, falling back safely:', error);
    return runFallbackTriage(description, submittedCategory);
  }
}
