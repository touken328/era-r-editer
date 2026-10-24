/* =========================================================
   js_edit.js - ERB 공통 편집기 (Talk / Event / Act 공용 통합본)
   - PRINT 명령어 파싱 및 그룹화
   - 조건식 더블클릭 인라인 수정 지원
   - 캐릭터 번호 변경 시 입력 내용(Draft) 보존 및 프리뷰 연동
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  let originalLines = [];
  let currentFileName = '';
  let renderGroups = [];

  const fileInput = document.getElementById('fileInput');
  const fileStatus = document.getElementById('fileStatus');
  const editorArea = document.getElementById('editorArea');
  const previewArea = document.getElementById('previewArea');
  const previewStatus = document.getElementById('previewStatus');

  const SAVED_FILES_KEY = 'era_erb_saved_files';
  let lastDirHandle = null;

  const LINE_REGEX = /^(\s*)(PRINTFORML|PRINTFORMW|PRINTFORMDL|PRINTFORMDW|PRINTL|PRINTW|PRINTDL|PRINT|PRINTSL|PRINTS)(?:\s+(.*))?$/;
  const FUNC_REGEX = /^\s*@([A-Za-z0-9_]+)/;
  const IF_REGEX = /^\s*(IF|ELSEIF|ELSE|ENDIF|SELECTCASE|CASE|CASEELSE|ENDSELECT)\b(.*)$/;

  // 범용 캐릭터 번호(K번호) 추출 및 치환 정규식
  const KOJO_IDENT_SRC = 'KOJO_[A-Za-z]+\\d*_K(\\d+)';
  const KOJO_CHAR_NUM_REGEXES = [
    new RegExp(KOJO_IDENT_SRC)
  ];

  function replaceKojoCharNum(line, newK) {
    return line.replace(new RegExp('(KOJO_[A-Za-z]+\\d*_K)\\d+', 'g'), '$1' + newK);
  }

  /* =========================================================
     파일 로드
     ========================================================= */
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    currentFileName = file.name;
    fileStatus.textContent = file.name + ' 로드됨';

    const reader = new FileReader();
    reader.onload = (ev) => {
      let text = ev.target.result;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

      originalLines = text.split('\n');
      parseAndGroup();

      const charNumInput = document.getElementById('charNumInput');
      if (renderGroups.length > 0) {
        const firstName = renderGroups[0].name;
        let found = '';
        for (const re of KOJO_CHAR_NUM_REGEXES) {
          const m = firstName.match(re);
          if (m) { found = m[1]; break; }
        }
        charNumInput.value = found;
      } else {
        charNumInput.value = '';
      }

      renderEditor();
      document.dispatchEvent(new CustomEvent('erb:rendered'));
      setTimeout(autoResizeAll, 0);
    };
    reader.readAsText(file, 'utf-8');
  });

  /* =========================================================
     파싱 & 그룹화
     ========================================================= */
  function parseAndGroup() {
    renderGroups = [];
    let currentFunc = '';

    const funcs = {};
    let currentFuncData = null;
    let currentCondition = { type: '', cond: '', lineIndex: -1 };
    let ifStack = [];

    originalLines.forEach((line, index) => {
      let cleanLine = line.replace(/\r$/, '');

      let funcMatch = cleanLine.match(FUNC_REGEX);
      if (funcMatch) {
        currentFunc = funcMatch[1];
        if (!funcs[currentFunc]) {
          funcs[currentFunc] = { name: currentFunc, blocks: [] };
        }
        currentFuncData = funcs[currentFunc];
        currentFuncData.blocks.push({ type: 'function_decl', lineIndex: index });
        currentCondition = { type: '', cond: '', lineIndex: -1 };
        ifStack = [];
        return;
      }

      if (!currentFuncData) return;

      let ifMatch = cleanLine.match(IF_REGEX);
      if (ifMatch) {
        let type = ifMatch[1];
        let cond = ifMatch[2].trim();

        if (type === 'ENDIF' || type === 'ENDSELECT') {
          ifStack.pop();
          currentCondition = { type: type, cond: '', lineIndex: index };
        } else if (type === 'ELSE' || type === 'CASEELSE') {
          currentCondition = { type: type, cond: '', lineIndex: index };
        } else if (type === 'CASE') {
          currentCondition = { type: type, cond: cond, lineIndex: index };
        } else {
          if (type === 'IF' || type === 'SELECTCASE') ifStack.push(1);
          currentCondition = { type: type, cond: cond, lineIndex: index };
        }

        currentFuncData.blocks.push({
          type: 'code_line',
          lineIndex: index,
          content: cleanLine
        });
        return;
      }

      let match = cleanLine.match(LINE_REGEX);
      if (match) {
        let lastBlock = currentFuncData.blocks[currentFuncData.blocks.length - 1];
        let indentDepth = ifStack.length;

        if (lastBlock && lastBlock.type === 'print_group') {
          lastBlock.lines.push({
            lineIndex: index,
            indent: match[1] || '',
            cmd: match[2],
            text: match[3] || '',
            depth: indentDepth
          });
        } else {
          currentFuncData.blocks.push({
            type: 'print_group',
            condition: { ...currentCondition },
            depth: indentDepth,
            lines: [{
              lineIndex: index,
              indent: match[1] || '',
              cmd: match[2],
              text: match[3] || '',
              depth: indentDepth
            }]
          });
        }
      } else {
        if (cleanLine.trim().startsWith(';') || cleanLine.trim() === '') {
          return;
        }
        currentFuncData.blocks.push({
          type: 'code_line',
          lineIndex: index,
          content: cleanLine
        });
      }
    });

    renderGroups = Object.values(funcs);
  }

  function getContentCharCount(lines) {
    let total = 0;
    lines.forEach(line => {
      let txt = line.text;
      if (/^「\s*」$/.test(txt.trim())) return;
      total += txt.length;
    });
    return total;
  }

  /* =========================================================
     렌더링
     ========================================================= */
  function renderEditor() {
    if (renderGroups.length === 0) {
      editorArea.innerHTML = '<div style="color:var(--muted); text-align:center; margin-top:50px;">수정할 PRINT 명령어가 없습니다.</div>';
      const totalEl = document.getElementById('totalCharsDisplay');
      if (totalEl) totalEl.textContent = '총 글자수 : 0 자';
      return;
    }

    let grandTotalChars = 0;
    let html = '';

    html += `<div class="category-group" id="cat_all">`;
    html += `  <div class="category-header" onclick="toggleCategory(this)">`;
    html += `    <span>`;
    html += `      <span class="cat-name">[기타]</span> `;
    html += `      <span class="cat-count">(${renderGroups.length}개)</span>`;
    html += `      <span class="cat-chars">/ 0 자</span>`;
    html += `    </span>`;
    html += `    <button class="category-toggle">[+] 펼치기</button>`;
    html += `  </div>`;
    html += `  <div class="category-content">`;

    renderGroups.forEach(func => {
      let funcChars = 0;
      func.blocks.forEach(block => {
        if (block.type === 'print_group') {
          funcChars += getContentCharCount(block.lines);
        }
      });
      grandTotalChars += funcChars;

      html += `<div class="func-group ev" id="func_${func.name}">`;
      html += `  <div class="func-header">@${func.name}</div>`;

      let currentBlockChain = [];

      func.blocks.forEach((block, bIdx) => {
        if (block.type === 'print_group') {
          let combinedText = '';
          let firstCmd = block.lines[0].cmd;
          let isMixed = false;
          let isEmpty = true;

          block.lines.forEach((line, lIdx) => {
            let txt = line.text;
            let cleanedTxt = txt.replace(/^「\s*」$/, '').trimStart();
            if (cleanedTxt.trim() !== '') isEmpty = false;

            if (lIdx === 0) {
              combinedText += cleanedTxt;
            } else {
              let prevCmd = block.lines[lIdx - 1].cmd;
              if (['PRINTW', 'PRINTFORMDW', 'PRINTFORMW'].includes(prevCmd)) {
                combinedText += '\n\n' + cleanedTxt;
              } else {
                combinedText += '\n' + cleanedTxt;
              }
            }
            if (line.cmd !== firstCmd) isMixed = true;
          });

          const startIdx = block.lines[0].lineIndex;
          const endIdx = block.lines[block.lines.length - 1].lineIndex;

          const blockChars = getContentCharCount(block.lines);
          const blockCharsFormatted = blockChars.toLocaleString();

          let branchHtml = '';
          let cond = block.condition;

          if (cond && cond.type) {
            let typeClass = '';
            let label = cond.type;
            if (cond.type === 'IF') typeClass = 'branch-IF';
            else if (cond.type === 'ELSEIF') typeClass = 'branch-ELSEIF';
            else if (cond.type === 'ELSE') typeClass = 'branch-ELSE';
            else if (cond.type === 'ENDIF') typeClass = 'branch-ENDIF';
            else if (cond.type === 'SELECTCASE') typeClass = 'branch-SELECTCASE';
            else if (cond.type === 'CASE') typeClass = 'branch-CASE';
            else if (cond.type === 'CASEELSE') typeClass = 'branch-ELSE';
            else if (cond.type === 'ENDSELECT') typeClass = 'branch-ENDIF';

            branchHtml = `<span class="branch ${typeClass}">${label} 블록</span>`;

            let showCond = cond.cond;
            if (cond.type === 'ELSE' || cond.type === 'CASEELSE' || cond.type === 'ENDIF' || cond.type === 'ENDSELECT') {
              showCond = '';
            }
            if (showCond) {
              branchHtml += `<span class="condition"
                data-line-index="${cond.lineIndex}"
                data-type="${cond.type}"
                title="더블클릭하여 수정">${escapeHtml(showCond)}</span>`;
            }
          } else {
            branchHtml = `<span class="branch" style="background:#444;">PRINT 블록</span>`;
          }

          if (isEmpty) {
            currentBlockChain.push({
              html: `
                <div class="print-item" id="group_${func.name}_${bIdx}">
                  <div class="print-meta">
                    <span style="display:flex; align-items:center; flex-shrink: 0; flex-wrap: wrap;">${branchHtml}</span>
                    <span style="white-space: nowrap;">
                      <span class="char-count">${blockCharsFormatted}자</span> / Line ${startIdx + 1} ~ ${endIdx + 1}
                    </span>
                  </div>
                  <textarea class="group-input"
                            data-func="${func.name}"
                            data-bidx="${bIdx}"
                            data-start="${startIdx}"
                            data-end="${endIdx}"
                            data-depth="${block.depth || 0}"
                            spellcheck="false">${escapeHtml(combinedText)}</textarea>
                </div>
              `,
              isEmpty: true,
              branchHtml: branchHtml
            });
          } else {
            if (currentBlockChain.length > 0) {
              html += buildCollapsedGroup(func.name, bIdx, currentBlockChain);
              currentBlockChain = [];
            }
            html += `
              <div class="print-item" id="group_${func.name}_${bIdx}">
                <div class="print-meta">
                  <span style="display:flex; align-items:center; flex-shrink: 0; flex-wrap: wrap;">${branchHtml}</span>
                  <span style="white-space: nowrap;">
                    <span class="char-count">${blockCharsFormatted}자</span> / Line ${startIdx + 1} ~ ${endIdx + 1}
                  </span>
                </div>
                <textarea class="group-input"
                          data-func="${func.name}"
                          data-bidx="${bIdx}"
                          data-start="${startIdx}"
                          data-end="${endIdx}"
                          data-depth="${block.depth || 0}"
                          spellcheck="false">${escapeHtml(combinedText)}</textarea>
            </div>
          `;
          }
        }
      });

      if (currentBlockChain.length > 0) {
        html += buildCollapsedGroup(func.name, func.blocks.length, currentBlockChain);
      }

      html += `</div>`;
    });

    html += `  </div>`;
    html += `</div>`;

    editorArea.innerHTML = html;

    const totalEl = document.getElementById('totalCharsDisplay');
    if (totalEl) {
      totalEl.textContent = '총 글자수 : ' + grandTotalChars.toLocaleString() + ' 자';
    }
  }

  function buildCollapsedGroup(funcName, bIdx, chain) {
    let innerHtml = '';
    chain.forEach(item => { innerHtml += item.html; });

    return `
      <div class="collapsed-group">
        <div class="collapsed-header" onclick="toggleCollapse(this)">
          <span>📁 빈 블록 ${chain.length}개 접힘 (클릭하여 펼치기)</span>
          <button class="toggle-btn">[+]</button>
        </div>
        <div class="collapsed-content">
          ${innerHtml}
        </div>
      </div>
    `;
  }

  window.toggleCategory = function(headerEl) {
    const content = headerEl.nextElementSibling;
    const btn = headerEl.querySelector('.category-toggle');
    if (content.classList.contains('open')) {
      content.classList.remove('open');
      btn.textContent = '[+] 펼치기';
    } else {
      content.classList.add('open');
      btn.textContent = '[-] 접기';
      setTimeout(() => {
        content.querySelectorAll('.group-input').forEach(autoResize);
      }, 0);
    }
  };

  window.toggleCollapse = function(headerEl) {
    const content = headerEl.nextElementSibling;
    const btn = headerEl.querySelector('.toggle-btn');
    if (content.classList.contains('open')) {
      content.classList.remove('open');
      btn.textContent = '[+]';
    } else {
      content.classList.add('open');
      btn.textContent = '[-]';
      setTimeout(() => {
        content.querySelectorAll('.group-input').forEach(autoResize);
      }, 0);
    }
  };

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function autoResizeAll() {
    document.querySelectorAll('.group-input').forEach(autoResize);
  }

  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('group-input')) {
      autoResize(e.target);
    }
  });

  window.addEventListener('resize', autoResizeAll);

  // 조건식 더블클릭 인라인 수정 기능 복구
  document.addEventListener('dblclick', (e) => {
    if (e.target.classList.contains('condition')) {
      const span = e.target;
      const lineIndex = parseInt(span.dataset.lineIndex, 10);
      const type = span.dataset.type;
      const currentText = span.textContent;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'condition-input';
      input.value = currentText;

      span.style.display = 'none';
      span.parentNode.insertBefore(input, span.nextSibling);
      input.focus();
      input.select();

      const finishEdit = () => {
        const newValue = input.value.trim();
        if (newValue !== currentText) {
          let line = originalLines[lineIndex].replace(/\r$/, '');
          let regex = new RegExp('^(\\s*' + type + ')\\s+.*$');
          originalLines[lineIndex] = line.replace(regex, `$1 ${newValue}`);

          span.textContent = newValue;

          renderGroups.forEach(func => {
            func.blocks.forEach(block => {
              if (block.type === 'print_group' && block.condition.lineIndex === lineIndex) {
                block.condition.cond = newValue;
              }
            });
          });
        }
        input.remove();
        span.style.display = '';
      };

      input.addEventListener('blur', finishEdit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = currentText; input.blur(); }
      });
    }
  });

  /* =========================================================
     이동 기능
     ========================================================= */
  function findAndScroll() {
    const input = document.getElementById('findIdInput');
    const targetId = input.value.trim();
    if (!targetId) {
      alert('번호를 입력해 주세요.');
      return;
    }

    const allGroups = document.querySelectorAll('.func-group');
    let found = null;

    for (const group of allGroups) {
      const header = group.querySelector('.func-header');
      if (!header) continue;
      const funcName = header.textContent.replace('@', '').trim();

      if (funcName.includes('_' + targetId) || funcName.endsWith('_' + targetId)) {
        found = group;
        break;
      }
    }

    if (found) {
      const categoryGroup = found.closest('.category-group');
      if (categoryGroup) {
        const content = categoryGroup.querySelector('.category-content');
        const btn = categoryGroup.querySelector('.category-toggle');
        if (content && !content.classList.contains('open')) {
          content.classList.add('open');
          btn.textContent = '[-] 접기';
        }
      }

      const collapsedParent = found.closest('.collapsed-content');
      if (collapsedParent && !collapsedParent.classList.contains('open')) {
        collapsedParent.classList.add('open');
        const toggleBtn = collapsedParent.previousElementSibling.querySelector('.toggle-btn');
        if (toggleBtn) toggleBtn.textContent = '[-]';
      }

      setTimeout(() => {
        found.scrollIntoView({ behavior: 'smooth', block: 'start' });
        found.classList.add('highlight');
        setTimeout(() => found.classList.remove('highlight'), 2000);
        setTimeout(autoResizeAll, 50);
      }, 100);
    } else {
      alert('해당 번호(' + targetId + ')의 블록을 찾을 수 없습니다.');
    }
  }

  document.getElementById('btnFind').addEventListener('click', findAndScroll);
  document.getElementById('findIdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') findAndScroll();
  });

  document.getElementById('btnCollapseAll').addEventListener('click', () => {
    document.querySelectorAll('.category-content').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.category-toggle').forEach(btn => btn.textContent = '[+] 펼치기');
    document.querySelectorAll('.collapsed-content').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.toggle-btn').forEach(btn => btn.textContent = '[+]');
  });

  document.getElementById('btnExpandAll').addEventListener('click', () => {
    document.querySelectorAll('.category-content').forEach(el => el.classList.add('open'));
    document.querySelectorAll('.category-toggle').forEach(btn => btn.textContent = '[-] 접기');
    document.querySelectorAll('.collapsed-content').forEach(el => el.classList.add('open'));
    document.querySelectorAll('.toggle-btn').forEach(btn => btn.textContent = '[-]');
    setTimeout(autoResizeAll, 50);
  });

  /* =========================================================
     이름/조사 변환 및 조건식 변환 헬퍼
     ========================================================= */
  function applyNameAndJosaConversion(text, placeholder, callName) {
    const patterns = [
      { josa: ['은', '는'] },
      { josa: ['이', '가'] },
      { josa: ['을', '를'] },
      { josa: ['과', '와'] },
      { josa: ['으로', '로'] }
    ];

    let result = text;

    patterns.forEach(({ josa }) => {
      const regex = new RegExp('\\[' + placeholder + '\\](' + josa.join('|') + ')', 'g');
      result = result.replace(regex, (match, matchedJosa) => {
        let first, second;
        if (matchedJosa === josa[0]) {
          first = josa[0]; second = josa[1];
        } else {
          first = josa[1]; second = josa[0];
        }

        const talentKey = callName === '%CALLNAME:MASTER%' ? 'TALENT:MASTER:170' : 'TALENT:TARGET:170';
        return callName + '\\@ ' + talentKey + ' ? ' + first + ' # ' + second + ' \\@';
      });
    });

    result = result.replace(new RegExp('\\[' + placeholder + '\\]', 'g'), callName);

    return result;
  }

  function transformRandConditions(text) {
    return text.replace(/\b(IF|ELSEIF)(\s+)RAND:(\d+)\s*==\s*0\b/g, '$1$2!RAND:$3');
  }

  /* =========================================================
     출력 결과 생성 및 프리뷰 갱신 공통 함수
     ========================================================= */
  function updatePreview() {
    if (originalLines.length === 0) return;

    const textareas = document.querySelectorAll('.group-input');
    const replacements = [];

    textareas.forEach(ta => {
      const startIdx = parseInt(ta.dataset.start, 10);
      const endIdx = parseInt(ta.dataset.end, 10);
      const depth = parseInt(ta.dataset.depth, 10) || 0;

      let rawText = ta.value;
      rawText = rawText.replace(/\.\.\./g, '…');
      rawText = rawText.replace(/"([^"\n]*)"/g, '「$1」');

      rawText = rawText.split('\n').map(line => {
        if (/^「\s*」$/.test(line.trim())) return '';
        return line;
      }).join('\n');

      rawText = applyNameAndJosaConversion(rawText, '이름', '%CALLNAME:MASTER%');
      rawText = applyNameAndJosaConversion(rawText, '남사', '%CALLNAME:TARGET%');

      const paragraphs = rawText.split(/\n\s*\n/);

      let firstLineMatch = originalLines[startIdx] ? originalLines[startIdx].match(LINE_REGEX) : null;
      let originalIndent = firstLineMatch ? firstLineMatch[1] : '';
      let targetIndent = originalIndent || ('\t'.repeat(depth));

      const newBlock = [];

      paragraphs.forEach(para => {
        const lines = para.split('\n').map(l => l.trim()).filter(l => l !== '');
        if (lines.length === 0) return;

        lines.forEach((line, i) => {
          let cmd;
          if (/^／.*／$/.test(line) || /^「.*」$/.test(line)) {
            cmd = (i === lines.length - 1) ? 'PRINTFORMW' : 'PRINTFORML';
          } else {
            cmd = (i === lines.length - 1) ? 'PRINTFORMDW' : 'PRINTFORMDL';
          }
          newBlock.push(targetIndent + cmd + ' ' + line);
        });
      });

      if (newBlock.length === 0) {
        newBlock.push(targetIndent + 'PRINTFORMW');
      }

      replacements.push({
        start: startIdx,
        end: endIdx,
        newLines: newBlock
      });
    });

    replacements.sort((a, b) => b.start - a.start);

    let newLines = [...originalLines];

    replacements.forEach(rep => {
      newLines.splice(rep.start, rep.end - rep.start + 1, ...rep.newLines);
    });

    let resultCode = newLines.join('\n');
    resultCode = transformRandConditions(resultCode);

    previewArea.textContent = resultCode;
  }

  /* =========================================================
     출력 버튼 이벤트
     ========================================================= */
  document.getElementById('btnOutput').addEventListener('click', () => {
    if (originalLines.length === 0) {
      alert('먼저 .erb 파일을 불러와 주세요.');
      return;
    }

    updatePreview();
    previewStatus.textContent = '출력 완료';
  });

  /* =========================================================
     캐릭터 번호 일괄 변경 (입력 내용 보존 및 프리뷰 연동)
     ========================================================= */
  document.getElementById('btnChangeCharNum').addEventListener('click', () => {
    if (originalLines.length === 0) {
      alert('먼저 .erb 파일을 불러와 주세요.');
      return;
    }

    const newK = document.getElementById('charNumInput').value.trim();
    if (!newK || !/^\d+$/.test(newK)) {
      alert('변경할 캐릭터 번호(K번호)를 숫자로 입력해 주세요.');
      return;
    }

    if (!confirm('모든 함수의 캐릭터 번호를 K' + newK + ' 로 변경하시겠습니까?')) {
      return;
    }

    // 작성 중인 내용(Draft) 보존
    const draft = {};
    document.querySelectorAll('.group-input').forEach(ta => {
      draft[ta.dataset.start] = ta.value;
    });

    originalLines = originalLines.map(line => replaceKojoCharNum(line, newK));

    parseAndGroup();
    renderEditor();
    document.dispatchEvent(new CustomEvent('erb:rendered'));

    // 편집 내용 복원
    document.querySelectorAll('.group-input').forEach(ta => {
      if (Object.prototype.hasOwnProperty.call(draft, ta.dataset.start)) {
        ta.value = draft[ta.dataset.start];
      }
    });
    setTimeout(autoResizeAll, 0);

    updatePreview();

    previewStatus.textContent = '캐릭터 번호가 K' + newK + ' 로 변경되었습니다.';
  });

  /* =========================================================
     저장
     ========================================================= */
  document.getElementById('btnSave').addEventListener('click', async () => {
    const text = previewArea.textContent;
    if (!text || text.includes('(출력 버튼을 누르면')) {
      alert('먼저 [출력] 버튼을 눌러주세요.');
      return;
    }

    let baseName = currentFileName.replace(/\.erb$/i, '') || 'KOJO_TALK_K1_0';
    const ext = '.ERB';

    let savedFiles = [];
    try { savedFiles = JSON.parse(localStorage.getItem(SAVED_FILES_KEY) || '[]'); } catch (e) {}

    let finalName = baseName + ext;
    let counter = 1;
    while (savedFiles.includes(finalName)) {
      finalName = baseName + '_' + counter + ext;
      counter++;
    }

    if (window.showSaveFilePicker) {
      try {
        const options = {
          suggestedName: finalName,
          types: [{
            description: 'ERB Script File',
            accept: { 'text/plain': ['.ERB', '.erb'] }
          }]
        };

        if (lastDirHandle) {
          options.startIn = lastDirHandle;
        }

        const fileHandle = await window.showSaveFilePicker(options);

        try {
          lastDirHandle = fileHandle;
        } catch (e) {}

        const writable = await fileHandle.createWritable();
        await writable.write('\uFEFF' + text);
        await writable.close();

        savedFiles.push(finalName);
        try { localStorage.setItem(SAVED_FILES_KEY, JSON.stringify(savedFiles)); } catch (e) {}

        previewStatus.textContent = '저장 완료: ' + finalName;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(err);
        alert('저장 중 오류가 발생했습니다: ' + err.message);
      }
    } else {
      savedFiles.push(finalName);
      try { localStorage.setItem(SAVED_FILES_KEY, JSON.stringify(savedFiles)); } catch (e) {}

      const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = finalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      previewStatus.textContent = '다운로드 폴더에 저장됨: ' + finalName;
    }
  });

  /* =========================================================
     복사
     ========================================================= */
  document.getElementById('btnCopy').addEventListener('click', async () => {
    const text = previewArea.textContent;
    if (!text || text.includes('(출력 버튼을 누르면')) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('btnCopy');
      const old = btn.textContent;
      btn.textContent = '복사됨!';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (e) {
      alert('복사에 실패했습니다. 미리보기 영역을 직접 선택해 복사해 주세요.');
    }
  });

  /* =========================================================
     내용 비우기
     ========================================================= */
  document.getElementById('btnClearContent').addEventListener('click', () => {
    if (originalLines.length === 0) {
      alert('먼저 .erb 파일을 불러와 주세요.');
      return;
    }

    if (!confirm('모든 PRINT문의 내용을 지우고 빈 블록으로 만드시겠습니까?\n(함수나 IF문 등 코드는 유지됩니다)')) {
      return;
    }

    const newLines = originalLines.map(line => {
      const cleanLine = line.replace(/\r$/, '');
      const match = cleanLine.match(LINE_REGEX);

      if (match) {
        return match[1] + match[2];
      }
      return line;
    });

    originalLines = newLines;

    parseAndGroup();
    renderEditor();
    document.dispatchEvent(new CustomEvent('erb:rendered'));
    setTimeout(autoResizeAll, 0);

    previewStatus.textContent = '내용이 모두 비워졌습니다. (출력 버튼을 눌러 확인하세요)';
  });

  /* =========================================================
     초기화
     ========================================================= */
  document.getElementById('btnClear').addEventListener('click', () => {
    if (!confirm('모든 내용을 초기화할까요?')) return;
    fileInput.value = '';
    currentFileName = '';
    fileStatus.textContent = '파일을 선택해 주세요.';
    originalLines = [];
    renderGroups = [];
    editorArea.innerHTML = '<div style="color:var(--muted); text-align:center; margin-top:50px;">상단에서 .erb 파일을 불러오면<br>여기에 수정할 텍스트 목록이 나타납니다.</div>';
    previewArea.textContent = '(출력 버튼을 누르면 여기에 원본 코드가 표시됩니다.)';
    previewStatus.textContent = '대기 중';
    document.getElementById('totalCharsDisplay').textContent = '총 글자수 : 0 자';
  });

  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  if (window.EraCommon && typeof window.EraCommon.initHeaderNav === 'function') {
    const page = document.body.getAttribute('data-page') || 'talk';
    window.EraCommon.initHeaderNav(page);
  }
});