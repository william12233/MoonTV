#!/usr/bin / env node

/* eslint-disable */

const fs = require('fs');
const path = require('path');

function parseChangelog(content) {
  const lines = content.split('\n');
  const versions = [];
  let currentVersion = null;
  let currentSection = null;
  let inVersionContent = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // 匹配版本行: ## [X.Y.Z] - YYYY-MM-DD
    const versionMatch = trimmedLine.match(
      /^## \[([\d.]+)\] - (\d{4}-\d{2}-\d{2})$/
    );
    if (versionMatch) {
      if (currentVersion) {
        versions.push(currentVersion);
      }

      currentVersion = {
        version: versionMatch[1],
        date: versionMatch[2],
        added: [],
        changed: [],
        fixed: [],
        content: [], // 用于存储原始内容，当没有分类时使用
      };
      currentSection = null;
      inVersionContent = true;
      continue;
    }

    // 如果遇到下一个版本或到达文件末尾，停止处理当前版本
    if (inVersionContent && currentVersion) {
      // 匹配章节标题
      if (trimmedLine === '### Added') {
        currentSection = 'added';
        continue;
      } else if (trimmedLine === '### Changed') {
        currentSection = 'changed';
        continue;
      } else if (trimmedLine === '### Fixed') {
        currentSection = 'fixed';
        continue;
      }

      // 匹配条目: - 内容
      if (trimmedLine.startsWith('- ') && currentSection) {
        const entry = trimmedLine.substring(2);
        currentVersion[currentSection].push(entry);
      } else if (
        trimmedLine &&
        !trimmedLine.startsWith('#') &&
        !trimmedLine.startsWith('###')
      ) {
        currentVersion.content.push(trimmedLine);
      }
    }
  }

  // 添加最后一个版本
  if (currentVersion) {
    versions.push(currentVersion);
  }

  // 后处理：如果某个版本没有分类内容，但有 content，则将 content 放到 changed 中
  versions.forEach((version) => {
    const hasCategories =
      version.added.length > 0 ||
      version.changed.length > 0 ||
      version.fixed.length > 0;
    if (!hasCategories && version.content.length > 0) {
      version.changed = version.content;
    }
    // 清理 content 字段
    delete version.content;
  });

  return { versions };
}

// 生成单引号字符串字面量，转义反斜杠与单引号，避免生成非法 TypeScript
function toTsStringLiteral(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// 按 Prettier 的默认风格输出数组内容（6 空格缩进 + 尾逗号），
// 保证生成结果与 lint-staged 格式化后的内容完全一致
function formatEntries(entries, emptyComment) {
  if (entries.length === 0) {
    return `      ${emptyComment}`;
  }

  return entries
    .map((entry) => `      ${toTsStringLiteral(entry)},`)
    .join('\n');
}

function generateTypeScript(changelogData) {
  const entries = changelogData.versions
    .map((version) => {
      return `  {
    version: '${version.version}',
    date: '${version.date}',
    added: [
${formatEntries(version.added, '// 无新增内容')}
    ],
    changed: [
${formatEntries(version.changed, '// 无变更内容')}
    ],
    fixed: [
${formatEntries(version.fixed, '// 无修复内容')}
    ]
  }`;
    })
    .join(',\n');

  return `// 此文件由 scripts/convert-changelog.js 自动生成
// 请勿手动编辑

export interface ChangelogEntry {
  version: string;
  date: string;
  added: string[];
  changed: string[];
  fixed: string[];
}

export const changelog: ChangelogEntry[] = [
${entries}
];

export default changelog;
`;
}

const CURRENT_VERSION_PATTERN = /const CURRENT_VERSION = ['"`][^'"`]+['"`];/;
const CURRENT_VERSION_VALUE_PATTERN =
  /const CURRENT_VERSION = ['"`]([^'"`]+)['"`];/;

function getVersionTxtPath() {
  return path.join(process.cwd(), 'VERSION.txt');
}

function getVersionTsPath() {
  return path.join(process.cwd(), 'src/lib/version.ts');
}

function updateVersionFile(version) {
  const versionTxtPath = getVersionTxtPath();
  const expectedContent = `${version}\n`;
  try {
    if (
      fs.existsSync(versionTxtPath) &&
      fs.readFileSync(versionTxtPath, 'utf8') === expectedContent
    ) {
      console.log(`✅ VERSION.txt 已是最新: ${version}`);
      return false;
    }

    fs.writeFileSync(versionTxtPath, expectedContent, 'utf8');
    console.log(`✅ 已更新 VERSION.txt: ${version}`);
    return true;
  } catch (error) {
    console.error(`❌ 无法更新 VERSION.txt:`, error.message);
    process.exit(1);
  }
}

function updateVersionTs(version) {
  const versionTsPath = getVersionTsPath();
  try {
    const content = fs.readFileSync(versionTsPath, 'utf8');

    if (!CURRENT_VERSION_PATTERN.test(content)) {
      console.error('❌ 未在 src/lib/version.ts 中找到 CURRENT_VERSION 常量');
      process.exit(1);
    }

    // 替换 CURRENT_VERSION 常量
    const updatedContent = content.replace(
      CURRENT_VERSION_PATTERN,
      `const CURRENT_VERSION = '${version}';`
    );

    if (updatedContent === content) {
      console.log(`✅ version.ts 已是最新: ${version}`);
      return false;
    }

    fs.writeFileSync(versionTsPath, updatedContent, 'utf8');
    console.log(`✅ 已更新 version.ts: ${version}`);
    return true;
  } catch (error) {
    console.error(`❌ 无法更新 version.ts:`, error.message);
    process.exit(1);
  }
}

function verifyVersionFiles(latestVersion, expectedChangelogTs) {
  const problems = [];

  const versionTxtPath = getVersionTxtPath();
  if (!fs.existsSync(versionTxtPath)) {
    problems.push('VERSION.txt 不存在');
  } else {
    const actualVersion = fs.readFileSync(versionTxtPath, 'utf8').trim();
    if (actualVersion !== latestVersion) {
      problems.push(
        `VERSION.txt 为 ${actualVersion}，CHANGELOG 最新版本为 ${latestVersion}`
      );
    }
  }

  const versionTsPath = getVersionTsPath();
  if (!fs.existsSync(versionTsPath)) {
    problems.push('src/lib/version.ts 不存在');
  } else {
    const versionTsContent = fs.readFileSync(versionTsPath, 'utf8');
    const match = versionTsContent.match(CURRENT_VERSION_VALUE_PATTERN);
    if (!match) {
      problems.push('src/lib/version.ts 中未找到 CURRENT_VERSION 常量');
    } else if (match[1] !== latestVersion) {
      problems.push(
        `version.ts 中 CURRENT_VERSION 为 ${match[1]}，CHANGELOG 最新版本为 ${latestVersion}`
      );
    }
  }

  const outputPath = path.join(process.cwd(), 'src/lib/changelog.ts');
  if (!fs.existsSync(outputPath)) {
    problems.push('src/lib/changelog.ts 不存在');
  } else if (fs.readFileSync(outputPath, 'utf8') !== expectedChangelogTs) {
    problems.push('src/lib/changelog.ts 与 CHANGELOG 不同步');
  }

  if (problems.length > 0) {
    console.error('❌ 版本文件不同步:');
    problems.forEach((problem) => console.error(`   - ${problem}`));
    console.error(
      '💡 请运行 `pnpm gen:version`（或 `node scripts/convert-changelog.js`）同步版本文件'
    );
    process.exit(1);
  }

  console.log(`✅ 版本文件已同步: ${latestVersion}`);
}

// 使用项目自身的 Prettier 配置格式化生成结果，
// 避免与 lint-staged 的格式化步骤互相覆盖导致每次提交都产生大 diff
async function formatWithPrettier(source, filePath) {
  let prettier;
  try {
    prettier = require('prettier');
  } catch (error) {
    console.error(
      '❌ 未找到 prettier，无法格式化生成文件，请先安装依赖（pnpm install）'
    );
    process.exit(1);
  }

  const config = (await prettier.resolveConfig(filePath)) || {};
  const formatted = await prettier.format(source, {
    ...config,
    filepath: filePath,
    // 仅从 .husky 搜索插件，避开 prettier-plugin-tailwindcss 的 ESM 兼容问题
    pluginSearchDirs: [path.join(process.cwd(), '.husky')],
  });

  if (typeof formatted !== 'string') {
    throw new Error('Prettier 未返回格式化后的字符串');
  }

  return formatted;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const skipVersion = args.includes('--no-version');

  try {
    const changelogPath = path.join(process.cwd(), 'CHANGELOG');
    const outputPath = path.join(process.cwd(), 'src/lib/changelog.ts');

    console.log('正在读取 CHANGELOG 文件...');
    const changelogContent = fs.readFileSync(changelogPath, 'utf-8');

    console.log('正在解析 CHANGELOG 内容...');
    const changelogData = parseChangelog(changelogContent);

    if (changelogData.versions.length === 0) {
      console.error('❌ 未在 CHANGELOG 中找到任何版本');
      process.exit(1);
    }

    // 获取最新版本号（CHANGELOG中的第一个版本）
    const latestVersion = changelogData.versions[0].version;
    console.log(`🔢 最新版本: ${latestVersion}`);

    console.log('正在生成 TypeScript 文件...');
    const tsContent = await formatWithPrettier(
      generateTypeScript(changelogData),
      outputPath
    );

    if (checkOnly) {
      // 校验模式：只检查，不写入任何文件
      verifyVersionFiles(latestVersion, tsContent);
    } else {
      // 确保输出目录存在
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      if (
        fs.existsSync(outputPath) &&
        fs.readFileSync(outputPath, 'utf8') === tsContent
      ) {
        console.log(`✅ ${outputPath} 已是最新`);
      } else {
        fs.writeFileSync(outputPath, tsContent, 'utf-8');
        console.log(`✅ 已生成 ${outputPath}`);
      }

      if (skipVersion) {
        console.log('⏭️  已跳过 VERSION.txt / version.ts 更新 (--no-version)');
      } else {
        console.log('正在同步版本文件...');
        updateVersionFile(latestVersion);
        updateVersionTs(latestVersion);
        // 写入后二次校验，避免更新逻辑失效却静默通过
        verifyVersionFiles(latestVersion, tsContent);
      }
    }
    console.log(`📊 版本统计:`);
    changelogData.versions.forEach((version) => {
      console.log(
        `   ${version.version} (${version.date}): +${version.added.length} ~${version.changed.length} !${version.fixed.length}`
      );
    });

    console.log('\n🎉 转换完成!');
  } catch (error) {
    console.error('❌ 转换失败:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ 转换失败:', error);
    process.exit(1);
  });
}
