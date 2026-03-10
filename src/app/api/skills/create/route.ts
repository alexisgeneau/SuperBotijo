/**
 * Create Skill API - Create a new custom skill in the workspace
 */
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/home/daniel/.openclaw';
const WORKSPACE_SKILLS_PATH = path.join(OPENCLAW_DIR, 'workspace/skills');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, name, description, emoji, homepage, content } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Skill ID is required' }, { status: 400 });
    }

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Skill name is required' }, { status: 400 });
    }

    // Sanitize ID: lowercase, alphanumeric and hyphens only
    const sanitizedId = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    if (!sanitizedId) {
      return NextResponse.json({ error: 'Invalid skill ID' }, { status: 400 });
    }

    const skillDir = path.join(WORKSPACE_SKILLS_PATH, sanitizedId);

    // Check if skill already exists
    if (fs.existsSync(skillDir)) {
      return NextResponse.json({ error: `Skill "${sanitizedId}" already exists` }, { status: 409 });
    }

    // Build SKILL.md content
    const frontMatterLines = [
      '---',
      `name: ${name}`,
      `description: ${description || 'Custom skill'}`,
    ];

    if (homepage) {
      frontMatterLines.push(`homepage: ${homepage}`);
    }

    if (emoji) {
      frontMatterLines.push(`metadata:`);
      frontMatterLines.push(`  openclaw:`);
      frontMatterLines.push(`    "emoji": "${emoji}"`);
    }

    frontMatterLines.push('---');

    const skillBody = content || `# ${name}\n\n${description || 'Custom skill created from SuperBotijo.'}`;
    const skillMdContent = frontMatterLines.join('\n') + '\n' + skillBody + '\n';

    // Create directory and write SKILL.md
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8');

    return NextResponse.json({
      success: true,
      skill: {
        id: sanitizedId,
        name,
        description: description || 'Custom skill',
        emoji: emoji || null,
        source: 'workspace',
        location: skillDir,
      },
      message: `Skill "${name}" created successfully`,
    }, { status: 201 });
  } catch (error) {
    console.error('[api/skills/create] POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create skill' },
      { status: 500 }
    );
  }
}
