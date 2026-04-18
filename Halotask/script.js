/* HaloTasks — Modular, commented, clear logic
   - Tasks persist in localStorage under key "halotasks.v1"
   - Each task: { id, text, completed, createdAt }
   - Features: add, toggle complete, edit inline, delete, filter
*/

(() => {
  const STORAGE_KEY = 'halotasks.v1';

  // DOM refs
  const newTaskInput = document.getElementById('newTaskInput');
  const addTaskBtn = document.getElementById('addTaskBtn');
  const taskList = document.getElementById('taskList');
  const filterButtons = Array.from(document.querySelectorAll('.filter-btn'));
  const clearCompletedBtn = document.getElementById('clearCompleted');
  const counterEl = document.getElementById('counter');

  // App state
  let tasks = [];            // array of task objects
  let filter = 'all';        // 'all' | 'active' | 'completed'

  /* ---------- Utilities ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);

  // Load from localStorage
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      tasks = raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('Failed to load tasks', e);
      tasks = [];
    }
  }

  // Save to localStorage
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.warn('Failed to save tasks', e);
    }
  }

  // Count helper
  function updateCounter() {
    const total = tasks.length;
    const active = tasks.filter(t => !t.completed).length;
    counterEl.textContent = `${active} active · ${total} total`;
  }

  /* ---------- Render ---------- */
  // Create DOM element for one task
  function createTaskElement(task) {
    const li = document.createElement('li');
    li.className = 'task-item new';
    li.dataset.id = task.id;

    // Checkbox wrapper (animated)
    const check = document.createElement('button');
    check.className = 'checkwrap' + (task.completed ? ' checked' : '');
    check.setAttribute('aria-label', task.completed ? 'Mark as incomplete' : 'Mark as complete');
    check.title = task.completed ? 'Mark as incomplete' : 'Mark as complete';
    check.type = 'button';

    const checkSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    checkSvg.setAttribute('viewBox','0 0 24 24');
    checkSvg.setAttribute('class','checkmark');
    checkSvg.innerHTML = `<path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;

    check.appendChild(checkSvg);

    // Body wrapper
    const body = document.createElement('div');
    body.className = 'task-body';

    const text = document.createElement('p');
    text.className = 'task-text' + (task.completed ? ' completed' : '');
    text.textContent = task.text;
    text.title = 'Double click to edit';
    text.tabIndex = 0; // keyboard focusable

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'meta';

    const time = document.createElement('div');
    time.className = 'small';
    // human-friendly relative time (simple)
    const date = new Date(task.createdAt || Date.now());
    time.textContent = date.toLocaleString();

    const actions = document.createElement('div');
    actions.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.title = 'Edit task';
    editBtn.innerHTML = '✎';
    editBtn.type = 'button';

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.title = 'Delete task';
    delBtn.innerHTML = '🗑';
    delBtn.type = 'button';

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    meta.appendChild(time);
    meta.appendChild(actions);

    // Assemble
    body.appendChild(text);
    body.appendChild(meta);

    li.appendChild(check);
    li.appendChild(body);

    /* ---------- Event handlers for this task element ---------- */

    // Toggle complete
    check.addEventListener('click', () => {
      toggleComplete(task.id);
    });

    // Delete with animation
    delBtn.addEventListener('click', () => {
      // trigger removal animation
      li.classList.add('removing');
      setTimeout(() => {
        removeTask(task.id);
      }, 320);
    });

    // Edit: double-click or edit button
    function startEdit() {
      // create editable input
      const input = document.createElement('input');
      input.className = 'edit-input';
      input.value = task.text;
      body.replaceChild(input, text);
      input.focus();
      // Select all text for convenience
      input.setSelectionRange(0, input.value.length);

      // Save & cleanup helpers
      function commit() {
        const val = input.value.trim();
        if (val) {
          task.text = val;
          updateTask(task);
        } else {
          // If cleared, treat as delete
          li.classList.add('removing');
          setTimeout(() => removeTask(task.id), 260);
        }
      }
      function cancel() {
        body.replaceChild(text, input);
      }

      // Keyboard events
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          cancel();
        }
      });
      // blur saves
      input.addEventListener('blur', () => {
        commit();
      });
    }

    editBtn.addEventListener('click', startEdit);
    text.addEventListener('dblclick', startEdit);
    // also allow Enter when focused on text (a11y)
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startEdit();
    });

    return li;
  }

  // Render the current list to DOM based on active filter
  function render() {
    // Clear existing
    taskList.innerHTML = '';

    let visible = tasks;
    if (filter === 'active') visible = tasks.filter(t => !t.completed);
    if (filter === 'completed') visible = tasks.filter(t => t.completed);

    // Sort: newest first
    visible = visible.slice().sort((a,b) => b.createdAt - a.createdAt);

    if (visible.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'task-item';
      hint.style.justifyContent = 'center';
      hint.textContent = 'No tasks — add your first one!';
      taskList.appendChild(hint);
    } else {
      const fragment = document.createDocumentFragment();
      visible.forEach(task => {
        const el = createTaskElement(task);
        fragment.appendChild(el);
      });
      taskList.appendChild(fragment);
    }

    updateCounter();
  }

  /* ---------- CRUD operations ---------- */

  function addTask(text) {
    const t = {
      id: uid(),
      text: text.trim(),
      completed: false,
      createdAt: Date.now()
    };
    tasks.push(t);
    save();
    render();
    // visual affordance: find the element and remove 'new' class after anim
    requestAnimationFrame(() => {
      const el = taskList.querySelector(`[data-id="${t.id}"]`);
      if (el) {
        setTimeout(() => el.classList.remove('new'), 380);
      }
    });
  }

  function updateTask(updated) {
    const i = tasks.findIndex(t => t.id === updated.id);
    if (i >= 0) {
      tasks[i] = { ...tasks[i], ...updated };
      save();
      render();
    }
  }

  function removeTask(id) {
    tasks = tasks.filter(t => t.id !== id);
    save();
    render();
  }

  function toggleComplete(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    t.completed = !t.completed;
    save();
    render();
  }

  function clearCompleted() {
    const any = tasks.some(t => t.completed);
    if (!any) return;
    tasks = tasks.filter(t => !t.completed);
    save();
    render();
  }

  /* ---------- Init + Event wiring ---------- */

  // Add via button or Enter
  addTaskBtn.addEventListener('click', () => {
    const v = newTaskInput.value.trim();
    if (!v) return;
    addTask(v);
    newTaskInput.value = '';
    newTaskInput.focus();
  });

  newTaskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTaskBtn.click();
    }
  });

  // Filters
  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.filter;
      render();
    });
  });

  // Clear completed
  clearCompletedBtn.addEventListener('click', () => {
    clearCompleted();
  });

  // keyboard accessibility: focus input on "/" key
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      newTaskInput.focus();
    }
  });

  // load once and render
  load();
  render();

  // Expose small API for debugging (optional)
  window.haloTasks = {
    getAll: () => tasks.slice(),
    add: (text) => addTask(String(text)),
    clearStorage: () => { localStorage.removeItem(STORAGE_KEY); load(); render(); }
  };
})();
