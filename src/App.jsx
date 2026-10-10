import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Archive, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  Clapperboard, Clock3, Film, GripVertical, History, ImagePlus, Pencil, Plus, Search,
  Download, Eye, RotateCcw, Settings2, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { getPoster, removePoster, savePoster, savePosterDataUrl } from './posterStore';

const pad = (value) => String(value).padStart(2, '0');
const DEFAULT_START_TIME = '09:00';
const TIME_OPTIONS = Array.from({ length: 288 }, (_, index) => {
  const minutes = index * 5;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
});
const timeLabel = (value) => `${value >= 1440 ? '次日 ' : ''}${pad(Math.floor(value / 60) % 24)}:${pad(value % 60)}`;
const roundUp = (value, step) => Math.ceil(value / step) * step;
const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const minutesFromTime = (value) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
const hasLocalPoster = (poster) => typeof poster === 'string' && poster.length > 0;
const isLegacyPoster = (poster) => typeof poster === 'string' && poster.startsWith('data:image/');
const legacyPosterKey = (id, poster) => {
  let hash = 0;
  for (let index = 0; index < poster.length; index += 1) {
    hash = (hash * 31 + poster.charCodeAt(index)) | 0;
  }
  return `legacy-${id}-${Math.abs(hash)}`;
};
const normalizeHalls = (value) => value.map((hall) => ({
  ...hall,
  startTime: hall.startTime || hall.openTime || DEFAULT_START_TIME,
}));

function calendarInfo(value) {
  const [, month, day] = value.split('-').map(Number);
  const festival = {
    '1-1': '元旦',
    '5-1': '劳动节',
    '10-1': '国庆节',
  }[`${month}-${day}`] || '';
  const weekday = new Date(`${value}T12:00:00`).getDay();
  return { festival };
}

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

async function compressPoster(file) {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12 MB');
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 700 / image.width, 1000 / image.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
  if (!blob) throw new Error('图片处理失败，请换一张图片');
  return blob;
}

function App() {
  const [tab, setTab] = useState('schedule');
  const [movies, setMovies] = useState(() => readStored('ps-movies', []));
  const [cinema, setCinema] = useState(() => localStorage.getItem('ps-cinema') || '');
  const [cinemaOptions, setCinemaOptions] = useState(() => {
    const saved = readStored('ps-cinema-options', []);
    const current = localStorage.getItem('ps-cinema') || '';
    return [...new Set(current ? [current, ...saved] : saved)];
  });
  const [cinemaWorkspaces, setCinemaWorkspaces] = useState(() => readStored('ps-cinema-workspaces', {}));
  const [date, setDate] = useState(() => dateKey(new Date()));
  const [cleaning, setCleaning] = useState(10);
  const [rounding, setRounding] = useState(5);
  const [query, setQuery] = useState('');
  const [movieSearch, setMovieSearch] = useState('');
  const [halls, setHalls] = useState(() => normalizeHalls(readStored('ps-halls', [{ id: 'hall-1', name: '1 号厅' }])));
  const [activeHallId, setActiveHallId] = useState(() => readStored('ps-active-hall', 'hall-1'));
  const [hallSelections, setHallSelections] = useState(() => readStored('ps-hall-selections', { 'hall-1': [] }));
  const [hallCounts, setHallCounts] = useState(() => readStored('ps-hall-counts', { 'hall-1': {} }));
  const [hallSchedules, setHallSchedules] = useState(() => readStored('ps-hall-schedules', { 'hall-1': [] }));
  const [history, setHistory] = useState(() => readStored('ps-history', []));
  const [showSettings, setShowSettings] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showHallManager, setShowHallManager] = useState(false);
  const [showCinemaDialog, setShowCinemaDialog] = useState(false);
  const [cinemaDraft, setCinemaDraft] = useState('');
  const [cinemaDialogError, setCinemaDialogError] = useState('');
  const [editor, setEditor] = useState(null);
  const [posterError, setPosterError] = useState('');
  const [draggingId, setDraggingId] = useState(null);
  const [deleteHistoryId, setDeleteHistoryId] = useState(null);
  const [showReset, setShowReset] = useState(false);
  const [editingHistoryId, setEditingHistoryId] = useState(null);
  const [previewHistoryEntry, setPreviewHistoryEntry] = useState(null);
  const [notice, setNotice] = useState('');
  const [posterUrls, setPosterUrls] = useState({});
  const backupInputRef = useRef(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const persist = (key, value) => {
    if (!writeStored(key, value)) {
      setNotice('本地存储空间不足，请移除部分封面或历史记录');
    }
  };

  useEffect(() => persist('ps-movies', JSON.stringify(movies)), [movies]);
  useEffect(() => persist('ps-cinema', cinema), [cinema]);
  useEffect(() => persist('ps-cinema-options', JSON.stringify(cinemaOptions)), [cinemaOptions]);
  useEffect(() => persist('ps-cinema-workspaces', JSON.stringify(cinemaWorkspaces)), [cinemaWorkspaces]);
  useEffect(() => persist('ps-halls', JSON.stringify(halls)), [halls]);
  useEffect(() => persist('ps-active-hall', JSON.stringify(activeHallId)), [activeHallId]);
  useEffect(() => persist('ps-hall-selections', JSON.stringify(hallSelections)), [hallSelections]);
  useEffect(() => persist('ps-hall-counts', JSON.stringify(hallCounts)), [hallCounts]);
  useEffect(() => persist('ps-hall-schedules', JSON.stringify(hallSchedules)), [hallSchedules]);
  useEffect(() => persist('ps-history', JSON.stringify(history)), [history]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let active = true;
    let createdUrls = [];
    const posterIds = new Set();
    movies.forEach((movie) => movie.posterId && posterIds.add(movie.posterId));
    history.forEach((entry) => {
      [...Object.values(entry.hallSchedules || {}).flat(), ...(entry.screenings || [])].forEach((item) => {
        if (item.movie?.posterId) posterIds.add(item.movie.posterId);
      });
    });
    Promise.all([...posterIds].map(async (posterId) => {
      const blob = await getPoster(posterId);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      createdUrls.push(url);
      return [posterId, url];
    })).then((entries) => {
      if (!active) {
        entries.forEach((entry) => entry && URL.revokeObjectURL(entry[1]));
        return;
      }
      setPosterUrls(Object.fromEntries(entries.filter(Boolean)));
    }).catch(() => setNotice('封面读取失败，请重新选择图片'));
    return () => {
      active = false;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [movies, history]);

  useEffect(() => {
    const legacyPosters = new Map();
    movies.forEach((movie) => {
      if (isLegacyPoster(movie.poster) && !movie.posterId) {
        legacyPosters.set(legacyPosterKey(movie.id, movie.poster), movie.poster);
      }
    });
    history.forEach((entry) => Object.values(entry.hallSchedules || {}).flat().forEach((item) => {
      const movie = item.movie;
      if (movie && isLegacyPoster(movie.poster) && !movie.posterId) {
        legacyPosters.set(legacyPosterKey(movie.id, movie.poster), movie.poster);
      }
    }));
    if (!legacyPosters.size) return undefined;
    let active = true;
    Promise.all([...legacyPosters.entries()].map(async ([posterId, poster]) => {
      await savePosterDataUrl(posterId, poster);
      return [poster, posterId];
    })).then((migratedIds) => {
      if (!active) return;
      const posterIdsByData = new Map(migratedIds.map(([poster, posterId]) => [poster, posterId]));
      const migrateMovie = (movie) => {
        if (!movie || !isLegacyPoster(movie.poster) || movie.posterId) return movie;
        return { ...movie, posterId: posterIdsByData.get(movie.poster), poster: '' };
      };
      const migrateSchedule = (schedule = []) => schedule.map((item) => ({ ...item, movie: migrateMovie(item.movie) }));
      setMovies((current) => current.map(migrateMovie));
      setHallSchedules((current) => Object.fromEntries(Object.entries(current).map(([hallId, schedule]) => [hallId, migrateSchedule(schedule)])));
      setCinemaWorkspaces((current) => Object.fromEntries(Object.entries(current).map(([name, workspace]) => [name, {
        ...workspace,
        hallSchedules: Object.fromEntries(Object.entries(workspace.hallSchedules || {}).map(([hallId, schedule]) => [hallId, migrateSchedule(schedule)])),
      }])));
      setHistory((current) => current.map((entry) => ({
        ...entry,
        screenings: migrateSchedule(entry.screenings),
        hallSchedules: Object.fromEntries(Object.entries(entry.hallSchedules || {}).map(([hallId, schedule]) => [hallId, migrateSchedule(schedule)])),
      })));
    }).catch(() => setNotice('旧版封面迁移失败，请重新选择图片'));
    return () => { active = false; };
  }, [movies, history]);

  function getPosterSrc(movie) {
    return posterUrls[movie.posterId] || movie.poster || '';
  }

  function openMovieEditor(movie) {
    if (!movie) {
      setEditor({ id: null, title: '', runtime: '', poster: '', posterId: '', posterBlob: null });
      return;
    }
    setEditor({ ...movie, poster: getPosterSrc(movie), posterBlob: null });
  }

  function snapshotSchedules(schedules) {
    return Object.fromEntries(Object.entries(schedules).map(([hallId, schedule]) => [
      hallId,
      schedule.map((item) => ({
        ...item,
        movie: { ...item.movie, poster: '', posterId: item.movie.posterId || '' },
      })),
    ]));
  }

  useEffect(() => {
    if (!cinema.trim()) return;
    setCinemaWorkspaces((current) => ({
      ...current,
      [cinema]: { date, halls, activeHallId, hallSelections, hallCounts, hallSchedules, editingHistoryId },
    }));
  }, [cinema, date, halls, activeHallId, hallSelections, hallCounts, hallSchedules, editingHistoryId]);

  const filteredMovies = useMemo(() => movies.filter((movie) =>
    movie.title.toLowerCase().includes(query.trim().toLowerCase())), [movies, query]);
  const visibleMovies = useMemo(() => movies.filter((movie) =>
    movie.title.toLowerCase().includes(movieSearch.trim().toLowerCase())), [movies, movieSearch]);
  const activeHall = halls.find((hall) => hall.id === activeHallId) || halls[0];
  const activeStartTime = activeHall?.startTime || DEFAULT_START_TIME;
  const selected = hallSelections[activeHall?.id] || [];
  const showCounts = hallCounts[activeHall?.id] || {};
  const screenings = hallSchedules[activeHall?.id] || [];
  const selectedMovies = selected.map((id) => movies.find((movie) => movie.id === id)).filter(Boolean);
  const totalRuntime = screenings.reduce((total, item) => total + item.movie.runtime, 0);
  const allScreenings = Object.values(hallSchedules).flat();

  function setCurrentSelected(value) {
    setHallSelections((current) => ({ ...current, [activeHall.id]: typeof value === 'function' ? value(current[activeHall.id] || []) : value }));
  }

  function setCurrentCounts(value) {
    setHallCounts((current) => ({ ...current, [activeHall.id]: typeof value === 'function' ? value(current[activeHall.id] || {}) : value }));
  }

  function setCurrentScreenings(value) {
    setHallSchedules((current) => ({ ...current, [activeHall.id]: typeof value === 'function' ? value(current[activeHall.id] || []) : value }));
  }

  function reflowSchedule(schedule, startAt, nextCleaning = cleaning, nextRounding = rounding) {
    let cursor = startAt;
    return schedule.map((item, index) => {
      const start = index === 0 ? startAt : roundUp(cursor, nextRounding);
      const end = start + Number(item.movie.runtime);
      const cleaningEnd = end + Number(nextCleaning);
      cursor = cleaningEnd;
      return { ...item, start, end, cleaningEnd };
    });
  }

  function hasUnsavedChanges() {
    if (!allScreenings.length && !Object.values(hallSelections).some((items) => items.length)) return false;
    const saved = history.find((item) => item.id === editingHistoryId)
      || history.find((item) => item.cinema === cinema && item.date === date);
    if (!saved) return true;
    return JSON.stringify({
      cinema, date, cleaning, rounding, halls, hallSelections, hallCounts, hallSchedules,
    }) !== JSON.stringify({
      cinema: saved.cinema,
      date: saved.date,
      cleaning: saved.cleaning,
      rounding: saved.rounding,
      halls: saved.halls,
      hallSelections: saved.hallSelections,
      hallCounts: saved.hallCounts,
      hallSchedules: saved.hallSchedules,
    });
  }

  function confirmDiscardChanges() {
    return !hasUnsavedChanges() || window.confirm('当前排片还有未保存的修改，确定要切换吗？');
  }

  function removeMovieFromSelection(movieId) {
    setCurrentSelected((current) => current.filter((id) => id !== movieId));
    setCurrentCounts((current) => {
      const next = { ...current };
      delete next[movieId];
      return next;
    });
    setCurrentScreenings((current) => {
      const remaining = current.filter((item) => item.movie.id !== movieId);
      let cursor = minutesFromTime(activeStartTime);
      return remaining.map((item, index) => {
        const start = index === 0 ? cursor : roundUp(cursor, rounding);
        const end = start + item.movie.runtime;
        const cleaningEnd = end + Number(cleaning);
        cursor = cleaningEnd;
        return { ...item, start, end, cleaningEnd };
      });
    });
  }

  function addMovie(movie) {
    if (selected.includes(movie.id)) {
      removeMovieFromSelection(movie.id);
      return;
    }
    if (!canAddMovie(movie)) return;
    setCurrentSelected((current) => current.includes(movie.id) ? current : [...current, movie.id]);
    setCurrentCounts((current) => ({ ...current, [movie.id]: current[movie.id] || 1 }));
  }

  function canAddMovie(movie) {
    if (selected.includes(movie.id)) return true;
    const nextCounts = { ...showCounts, [movie.id]: 1 };
    const nextLineup = makeLineup([...selectedMovies, movie], nextCounts);
    return arrangeLineup(nextLineup).length === nextLineup.length;
  }

  function changeShowCount(movieId, delta) {
    const nextCount = Math.max(1, Math.min(8, (showCounts[movieId] || 1) + delta));
    if (delta > 0) {
      const nextCounts = { ...showCounts, [movieId]: nextCount };
      const nextLineup = makeLineup(selectedMovies, nextCounts);
      if (arrangeLineup(nextLineup).length < nextLineup.length) return;
    }
    setCurrentCounts((current) => ({ ...current, [movieId]: nextCount }));
  }

  function clearCurrentHall() {
    if ((selected.length || screenings.length) && !window.confirm('确定清空当前影厅的排片吗？')) return;
    setCurrentSelected([]);
    setCurrentCounts({});
    setCurrentScreenings([]);
  }

  function makeLineup(movieList = selectedMovies, counts = showCounts) {
    const rounds = Math.max(0, ...movieList.map((movie) => counts[movie.id] || 1));
    return Array.from({ length: rounds }, (_, round) =>
      movieList.filter((movie) => (counts[movie.id] || 1) > round)).flat();
  }

  function arrangeLineup(lineup, startAt = minutesFromTime(activeStartTime)) {
    let cursor = startAt;
    const result = [];
    lineup.forEach((movie, index) => {
      const start = index === 0 ? cursor : roundUp(cursor, rounding);
      const end = start + Number(movie.runtime);
      const cleaningEnd = end + Number(cleaning);
      if (movie.runtime > 0) {
        result.push({ id: `${movie.id}-${index}-${Date.now()}`, movie, start, end, cleaningEnd });
        cursor = cleaningEnd;
      }
    });
    return result;
  }

  function generateSchedule() {
    if (!cinema.trim()) {
      setNotice('请先填写影院名称');
      return;
    }
    if (!selectedMovies.length) {
      setNotice('请先选择电影');
      return;
    }
    const existingCounts = screenings.reduce((result, item) => {
      result[item.movie.id] = (result[item.movie.id] || 0) + 1;
      return result;
    }, {});
    const addedCounts = {};
    const pending = makeLineup().filter((movie) => {
      addedCounts[movie.id] = (addedCounts[movie.id] || 0) + 1;
      return addedCounts[movie.id] > (existingCounts[movie.id] || 0);
    });
    if (!pending.length) {
      setNotice('当前选片已经全部排入');
      return;
    }
    const startAt = screenings.length
      ? roundUp(screenings[screenings.length - 1].cleaningEnd, rounding)
      : minutesFromTime(activeStartTime);
    setCurrentScreenings((current) => [...current, ...arrangeLineup(pending, startAt)]);
    setNotice(`已追加 ${pending.length} 场`);
  }

  function updateStart(id, value) {
    const index = screenings.findIndex((item) => item.id === id);
    if (index < 0 || !value) return;
    const start = minutesFromTime(value);
    const next = screenings.slice(0, index);
    let cursor = start;
    screenings.slice(index).forEach((item, offset) => {
      const itemStart = offset === 0 ? start : roundUp(cursor, rounding);
      const end = itemStart + item.movie.runtime;
      const cleaningEnd = end + Number(cleaning);
      next.push({ ...item, start: itemStart, end, cleaningEnd });
      cursor = cleaningEnd;
    });
    setCurrentScreenings(next);
  }

  function removeScreening(screeningId) {
    const screening = screenings.find((item) => item.id === screeningId);
    if (!screening) return;
    const movieId = screening.movie.id;
    const remainingMovieScreenings = screenings.filter(
      (item) => item.movie.id === movieId && item.id !== screeningId,
    ).length;
    setCurrentSelected((current) => remainingMovieScreenings
      ? current
      : current.filter((id) => id !== movieId));
    setCurrentCounts((current) => {
      const next = { ...current };
      if (remainingMovieScreenings) {
        next[movieId] = remainingMovieScreenings;
      } else {
        delete next[movieId];
      }
      return next;
    });
    setCurrentScreenings((current) => {
      const remaining = current.filter((item) => item.id !== screeningId);
      let cursor = minutesFromTime(activeStartTime);
      return remaining.map((item, index) => {
        const start = index === 0 ? cursor : roundUp(cursor, rounding);
        const end = start + item.movie.runtime;
        const cleaningEnd = end + Number(cleaning);
        cursor = cleaningEnd;
        return { ...item, start, end, cleaningEnd };
      });
    });
  }

  function addMovieScreening(movieId) {
    const movie = movies.find((item) => item.id === movieId);
    if (!movie || movie.runtime <= 0) return;
    const start = screenings.length
      ? roundUp(screenings[screenings.length - 1].cleaningEnd, rounding)
      : minutesFromTime(activeStartTime);
    const end = start + Number(movie.runtime);
    const cleaningEnd = end + Number(cleaning);
    setCurrentSelected((current) => current.includes(movieId) ? current : [...current, movieId]);
    setCurrentCounts((current) => ({ ...current, [movieId]: (current[movieId] || 0) + 1 }));
    setCurrentScreenings((current) => [
      ...current,
      { id: `${movie.id}-${current.length}-${Date.now()}`, movie, start, end, cleaningEnd },
    ]);
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    setDraggingId(null);
    if (!over || active.id === over.id) return;
    setCurrentScreenings((current) => {
      const oldIndex = current.findIndex((item) => item.id === active.id);
      const newIndex = current.findIndex((item) => item.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return current;
      const reordered = arrayMove(current, oldIndex, newIndex);
      let cursor = minutesFromTime(activeStartTime);
      return reordered.map((item, index) => {
        const start = index === 0 ? cursor : roundUp(cursor, rounding);
        const end = start + item.movie.runtime;
        const cleaningEnd = end + Number(cleaning);
        cursor = cleaningEnd;
        return { ...item, start, end, cleaningEnd };
      });
    });
  }

  async function saveMovie(event) {
    event.preventDefault();
    const title = editor.title.trim();
    const runtime = Number(editor.runtime);
    if (!title || !Number.isFinite(runtime) || runtime < 1) return;
    const movie = {
      id: editor.id || `local-${Date.now()}`,
      title,
      runtime,
      posterId: editor.posterId || '',
      status: editor.status || '上映',
    };
    try {
      if (editor.posterBlob) {
        movie.posterId = `${movie.id}-${Date.now()}`;
        await savePoster(movie.posterId, editor.posterBlob);
      }
    } catch {
      setPosterError('封面保存失败，请重试');
      return;
    }
    setMovies((current) => editor.id
      ? current.map((item) => item.id === editor.id ? movie : item)
      : [movie, ...current]);
    if (editor.id) {
      setHallSchedules((current) => Object.fromEntries(Object.entries(current).map(([hallId, schedule]) => {
        const updated = schedule.map((item) => item.movie.id === editor.id ? { ...item, movie } : item);
        const hall = halls.find((item) => item.id === hallId);
        const startAt = updated[0]?.start ?? minutesFromTime(hall?.startTime || DEFAULT_START_TIME);
        return [hallId, reflowSchedule(updated, startAt)];
      })));
    }
    setEditor(null);
    setPosterError('');
  }

  function deleteMovie(movieId) {
    const movie = movies.find((item) => item.id === movieId);
    if (movie?.posterId) removePoster(movie.posterId).catch(() => {});
    setMovies((current) => current.filter((movie) => movie.id !== movieId));
    setHallSelections((current) => Object.fromEntries(Object.entries(current).map(([hallId, selection]) => [
      hallId, selection.filter((id) => id !== movieId),
    ])));
    setHallCounts((current) => Object.fromEntries(Object.entries(current).map(([hallId, counts]) => {
      const next = { ...counts };
      delete next[movieId];
      return [hallId, next];
    })));
    setHallSchedules((current) => Object.fromEntries(Object.entries(current).map(([hallId, schedule]) => {
      const remaining = schedule.filter((item) => item.movie.id !== movieId);
      const hall = halls.find((item) => item.id === hallId);
      const startAt = remaining[0]?.start ?? minutesFromTime(hall?.startTime || DEFAULT_START_TIME);
      return [hallId, reflowSchedule(remaining, startAt)];
    })));
  }

  function saveSchedule() {
    const allScreenings = Object.values(hallSchedules).flat();
    if (!allScreenings.length) return;
    const existingEntry = history.find((item) => item.id === editingHistoryId)
      || history.find((item) => item.cinema === cinema && item.date === date);
    const entryId = existingEntry?.id || Date.now();
    const entry = {
      id: entryId, cinema, date, screenings: snapshotSchedules({ active: screenings }).active,
      cleaning, halls, hallSchedules: snapshotSchedules(hallSchedules),
      hallSelections, hallCounts, savedAt: new Date().toISOString(),
    };
    setHistory((current) => {
      const hasExisting = current.some((item) => item.id === entryId);
      const next = current.filter((item) => item.id !== entryId
        && !(item.cinema === cinema && item.date === date));
      return hasExisting || existingEntry ? [entry, ...next] : [entry, ...current];
    });
    setEditingHistoryId(entryId);
    setNotice(existingEntry ? '排片历史更新成功' : '排片历史保存成功');
  }

  function exportExcel() {
    const rows = Object.entries(hallSchedules).flatMap(([hallId, schedule]) => {
      const hall = halls.find((item) => item.id === hallId);
      return schedule.map((item, index) => ({
        日期: date,
        影院: cinema || '-',
        影厅: hall?.name || '-',
        场次: index + 1,
        电影: item.movie.title || '-',
        时长: item.movie.runtime || '-',
        开始时间: timeLabel(item.start),
        结束时间: timeLabel(item.end),
        保洁开始: timeLabel(item.end),
        保洁结束: timeLabel(item.cleaningEnd),
        保洁分钟: cleaning,
      }));
    });
    if (!rows.length) return;
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = [
      { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 22 },
      { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '排片场次');
    XLSX.writeFile(book, `${cinema || '影院'}-${date}-排片.xlsx`);
  }

  async function saveHistoryPreviewImage(entry) {
    const entryHalls = entry.halls || [{ id: 'legacy', name: '1 号厅' }];
    const entrySchedules = entry.hallSchedules || { legacy: entry.screenings || [] };
    const columnWidth = 260;
    const rowHeight = 96;
    const headerHeight = 92;
    const maxRows = Math.max(1, ...entryHalls.map((hall) => (entrySchedules[hall.id] || []).length));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(720, entryHalls.length * columnWidth + 40);
    canvas.height = headerHeight + maxRows * rowHeight + 30;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f6f5f1';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#242a27';
    context.font = '600 24px Microsoft YaHei, sans-serif';
    context.fillText(entry.cinema || '未命名影院', 20, 34);
    context.fillStyle = '#89908b';
    context.font = '14px Microsoft YaHei, sans-serif';
    context.fillText(`${entry.date}  ·  排片预览`, 20, 62);

    const imageCache = new Map();
    async function getPoster(posterId, legacyPoster) {
      const poster = posterUrls[posterId] || legacyPoster;
      if (!hasLocalPoster(poster)) return null;
      if (!imageCache.has(poster)) {
        imageCache.set(poster, new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = poster;
        }));
      }
      return imageCache.get(poster);
    }

    await Promise.all(entryHalls.flatMap((hall) => (entrySchedules[hall.id] || []).map((item) => getPoster(item.movie.posterId, item.movie.poster))));
    for (const [hallIndex, hall] of entryHalls.entries()) {
      const x = 20 + hallIndex * columnWidth;
      context.fillStyle = '#426f5a';
      context.fillRect(x, headerHeight - 28, columnWidth - 12, 28);
      context.fillStyle = '#fff';
      context.font = '600 14px Microsoft YaHei, sans-serif';
      context.fillText(hall.name, x + 10, headerHeight - 9);
      for (const [rowIndex, item] of (entrySchedules[hall.id] || []).entries()) {
        const y = headerHeight + rowIndex * rowHeight;
        context.fillStyle = '#fff';
        context.fillRect(x, y, columnWidth - 12, rowHeight - 8);
        context.strokeStyle = '#e7e7e1';
        context.strokeRect(x, y, columnWidth - 12, rowHeight - 8);
        const poster = await getPoster(item.movie.posterId, item.movie.poster);
        if (poster) {
          context.drawImage(poster, x + 10, y + 10, 42, 60);
        } else {
          context.fillStyle = '#e8eae2';
          context.fillRect(x + 10, y + 10, 42, 60);
        }
        context.fillStyle = '#242a27';
        context.font = '600 13px Microsoft YaHei, sans-serif';
        context.fillText(item.movie.title.slice(0, 17), x + 62, y + 28);
        context.fillStyle = '#89908b';
        context.font = '12px Microsoft YaHei, sans-serif';
        context.fillText(`${timeLabel(item.start)} - ${timeLabel(item.end)}`, x + 62, y + 51);
        context.fillText(`${item.movie.runtime} 分钟`, x + 62, y + 70);
      }
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${entry.cinema || '影院'}-${entry.date}-排片预览.png`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function createBackup() {
    const backup = {
      app: 'movie-scheduler',
      version: 1,
      exportedAt: new Date().toISOString(),
      movies,
      cinema,
      date,
      cleaning,
      rounding,
      halls,
      activeHallId,
      hallSelections,
      hallCounts,
      hallSchedules: snapshotSchedules(hallSchedules),
      history,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `片序备份-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function restoreBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'movie-scheduler' || !Array.isArray(data.movies) || !Array.isArray(data.halls)) {
        throw new Error('不是有效的片序备份文件');
      }
      setMovies(data.movies);
      setCinema(data.cinema || '');
      if (data.cinema) setCinemaOptions((current) => [...new Set([data.cinema, ...current])]);
      setDate(data.date || dateKey(new Date()));
      setCleaning(Number(data.cleaning) || 10);
      setRounding(Number(data.rounding) || 5);
      setHalls(normalizeHalls(data.halls));
      setActiveHallId(data.activeHallId || data.halls[0].id);
      setHallSelections(data.hallSelections || {});
      setHallCounts(data.hallCounts || {});
      setHallSchedules(data.hallSchedules || {});
      setHistory(data.history || []);
      setEditingHistoryId(null);
      setTab('schedule');
    } catch (error) {
      window.alert(error.message || '恢复失败，请选择正确的备份文件');
    } finally {
      event.target.value = '';
    }
  }

  function resetAll() {
    setMovies([]);
    setCinema('');
    setCinemaOptions([]);
    setCinemaWorkspaces({});
    setDate(dateKey(new Date()));
    setCleaning(10);
    setRounding(5);
    setHalls([{ id: 'hall-1', name: '1 号厅', startTime: DEFAULT_START_TIME }]);
    setActiveHallId('hall-1');
    setHallSelections({ 'hall-1': [] });
    setHallCounts({ 'hall-1': {} });
    setHallSchedules({ 'hall-1': [] });
    setHistory([]);
    setEditingHistoryId(null);
    setShowReset(false);
    setTab('schedule');
  }

  function loadHistory(entry) {
    if (!confirmDiscardChanges()) return;
    setCinema(entry.cinema);
    setDate(entry.date);
    if (entry.halls) {
      setHalls(normalizeHalls(entry.halls));
      setHallSchedules(entry.hallSchedules || {});
      setHallSelections(entry.hallSelections || {});
      setHallCounts(entry.hallCounts || {});
      setActiveHallId(entry.halls[0]?.id || activeHallId);
    } else {
      const legacyScreenings = entry.screenings || [];
      const legacyMovieIds = [...new Set(legacyScreenings.map((item) => item.movie.id))];
      const legacyCounts = legacyMovieIds.reduce((result, movieId) => {
        result[movieId] = legacyScreenings.filter((item) => item.movie.id === movieId).length;
        return result;
      }, {});
      setHalls([{ id: 'hall-1', name: '1 号厅', startTime: DEFAULT_START_TIME }]);
      setActiveHallId('hall-1');
      setHallSelections({ 'hall-1': legacyMovieIds });
      setHallCounts({ 'hall-1': legacyCounts });
      setHallSchedules({ 'hall-1': legacyScreenings });
    }
    setEditingHistoryId(entry.id);
    setTab('schedule');
  }

  function changeDate(nextDate) {
    if (nextDate === date) return;
    if (!confirmDiscardChanges()) return;
    const entry = history.find((item) => item.cinema === cinema && item.date === nextDate);
    setDate(nextDate);
    if (entry) {
      const nextHalls = normalizeHalls(entry.halls || halls);
      setHalls(nextHalls);
      setHallSchedules(entry.hallSchedules || {});
      setHallSelections(entry.hallSelections || {});
      setHallCounts(entry.hallCounts || {});
      setActiveHallId(entry.activeHallId || nextHalls[0]?.id || activeHallId);
      setEditingHistoryId(entry.id);
      return;
    }
    const emptyByHall = halls.reduce((result, hall) => ({ ...result, [hall.id]: [] }), {});
    setHallSchedules(emptyByHall);
    setHallSelections(emptyByHall);
    setHallCounts(halls.reduce((result, hall) => ({ ...result, [hall.id]: {} }), {}));
    setEditingHistoryId(null);
  }

  function switchCinema(nextCinema) {
    if (!nextCinema || nextCinema === cinema || !confirmDiscardChanges()) return;
    const workspace = cinemaWorkspaces[nextCinema];
    setCinema(nextCinema);
    if (workspace) {
      setDate(workspace.date || dateKey(new Date()));
      setHalls(normalizeHalls(workspace.halls || [{ id: 'hall-1', name: '1 号厅', startTime: DEFAULT_START_TIME }]));
      setActiveHallId(workspace.activeHallId || workspace.halls?.[0]?.id || 'hall-1');
      setHallSelections(workspace.hallSelections || {});
      setHallCounts(workspace.hallCounts || {});
      setHallSchedules(workspace.hallSchedules || {});
      setEditingHistoryId(workspace.editingHistoryId || null);
      return;
    }
    const defaultHall = { id: 'hall-1', name: '1 号厅', startTime: DEFAULT_START_TIME };
    setDate(dateKey(new Date()));
    setHalls([defaultHall]);
    setActiveHallId(defaultHall.id);
    setHallSelections({ [defaultHall.id]: [] });
    setHallCounts({ [defaultHall.id]: {} });
    setHallSchedules({ [defaultHall.id]: [] });
    setEditingHistoryId(null);
  }

  function addCinema() {
    setCinemaDraft('');
    setCinemaDialogError('');
    setShowCinemaDialog(true);
  }

  function deleteCinema() {
    if (!cinema || !window.confirm(`确定删除影院“${cinema}”吗？历史记录不会被删除。`)) return;
    const remaining = cinemaOptions.filter((name) => name !== cinema);
    const nextCinema = remaining[0] || '';
    setCinemaOptions(remaining);
    setCinemaWorkspaces((current) => {
      const next = { ...current };
      delete next[cinema];
      return next;
    });
    setCinema(nextCinema);
    setEditingHistoryId(null);
    if (nextCinema) {
      switchCinema(nextCinema);
    } else {
      setDate(dateKey(new Date()));
      setHalls([{ id: 'hall-1', name: '1 号厅', startTime: DEFAULT_START_TIME }]);
      setActiveHallId('hall-1');
      setHallSelections({ 'hall-1': [] });
      setHallCounts({ 'hall-1': {} });
      setHallSchedules({ 'hall-1': [] });
    }
    setNotice('影院已删除');
  }

  function confirmAddCinema(event) {
    event.preventDefault();
    const nextCinema = cinemaDraft.trim();
    if (!nextCinema) {
      setCinemaDialogError('请输入影院名称');
      return;
    }
    if (cinemaOptions.includes(nextCinema)) {
      setCinemaDialogError('该影院已经存在，请更换名称');
      return;
    }
    setCinemaOptions((current) => [...current, nextCinema]);
    setCinemaDialogError('');
    setShowCinemaDialog(false);
    switchCinema(nextCinema);
  }

  function shiftDate(amount) {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + amount);
    changeDate(dateKey(next));
  }

  function addHall() {
    const hall = {
      id: `hall-${Date.now()}`,
      name: `${halls.length + 1} 号厅`,
      startTime: DEFAULT_START_TIME,
    };
    setHalls((current) => [...current, hall]);
    setActiveHallId(hall.id);
  }

  function renameHall(id, name) {
    setHalls((current) => current.map((hall) => hall.id === id ? { ...hall, name: name || hall.name } : hall));
  }

  function updateHallStartTime(id, value) {
    setHalls((current) => current.map((hall) => hall.id === id ? { ...hall, startTime: value } : hall));
    setHallSchedules((current) => ({
      ...current,
      [id]: reflowSchedule(current[id] || [], minutesFromTime(value)),
    }));
  }

  function updateCleaning(value) {
    const nextCleaning = Number(value);
    setCleaning(nextCleaning);
    setHallSchedules((current) => Object.fromEntries(Object.entries(current).map(([hallId, schedule]) => {
      const hall = halls.find((item) => item.id === hallId);
      const startAt = schedule[0]?.start ?? minutesFromTime(hall?.startTime || DEFAULT_START_TIME);
      return [hallId, reflowSchedule(schedule, startAt, nextCleaning, rounding)];
    })));
  }

  function updateRounding(value) {
    const nextRounding = Number(value);
    setRounding(nextRounding);
    setHallSchedules((current) => Object.fromEntries(Object.entries(current).map(([hallId, schedule]) => {
      const hall = halls.find((item) => item.id === hallId);
      const startAt = schedule[0]?.start ?? minutesFromTime(hall?.startTime || DEFAULT_START_TIME);
      return [hallId, reflowSchedule(schedule, startAt, cleaning, nextRounding)];
    })));
  }

  function deleteHall(id) {
    if (halls.length <= 1) return;
    const nextHalls = halls.filter((hall) => hall.id !== id);
    setHalls(nextHalls);
    setActiveHallId((current) => current === id ? nextHalls[0].id : current);
    setHallSelections((current) => { const next = { ...current }; delete next[id]; return next; });
    setHallCounts((current) => { const next = { ...current }; delete next[id]; return next; });
    setHallSchedules((current) => { const next = { ...current }; delete next[id]; return next; });
  }

  async function handlePosterChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const blob = await compressPoster(file);
      const poster = URL.createObjectURL(blob);
      setEditor((current) => ({ ...current, poster, posterBlob: blob }));
      setPosterError('');
    } catch (error) {
      setPosterError(error.message);
    }
    event.target.value = '';
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setTab('schedule'); }}>
          <span className="brand-mark"><Clapperboard size={19} strokeWidth={1.8} /></span>
          <span>片序<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-right">
          <span className="today-label"><span className="live-dot" />私人排片工作台</span>
          <button className="icon-button" aria-label="排片设置" title="排片设置" onClick={() => setShowSettings(true)}><Settings2 size={18} /></button>
          <input ref={backupInputRef} className="hidden-file-input" type="file" accept="application/json,.json" onChange={restoreBackup} />
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="side-kicker">工作台</div>
          <button className={`nav-item ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>
            <Clapperboard size={17} /><span>排片</span><ChevronRight className="nav-arrow" size={15} />
          </button>
          <button className={`nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            <History size={17} /><span>历史</span>{history.length > 0 && <span className="nav-count">{history.length}</span>}
          </button>
          <div className="sidebar-bottom">
            <div className="sidebar-note"><span className="note-icon"><CircleHelp size={16} /></span><span>每场结束后自动预留保洁时间</span></div>
            <div className="version">片序 · 个人版 <span>v1.0</span></div>
          </div>
        </aside>

        <section className="main-content">
          {tab === 'schedule' ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow"><span className="eyebrow-line" />排片计划</div>
                  <h1>把好电影，排进好时间。</h1>
                  <p className="heading-copy">选好影片，剩下的时间交给片序。</p>
                </div>
                <div className="date-control">
                  <button className="date-arrow" onClick={() => shiftDate(-1)} aria-label="前一天"><ChevronLeft size={17} /></button>
                  <label className="date-display"><CalendarDays size={16} /><input aria-label="排片日期" type="date" value={date} onChange={(event) => changeDate(event.target.value)} /></label>
                  <button className="date-arrow" onClick={() => shiftDate(1)} aria-label="后一天"><ChevronRight size={17} /></button>
                </div>
              </div>

              <div className="setup-strip">
                <div className="cinema-field">
                  <span className="field-icon"><Film size={17} /></span>
                  <label htmlFor="cinema-name">当前影院</label>
                    <select id="cinema-name" className="cinema-select" value={cinema} onChange={(event) => switchCinema(event.target.value)}>
                      <option value="">选择影院</option>
                      {cinemaOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                    <button className="add-cinema-button" onClick={addCinema} type="button"><Plus size={14} />新增影院</button>
                    <button className="remove-cinema-button" onClick={deleteCinema} type="button" disabled={!cinema} aria-label="删除当前影院" title="删除当前影院"><Trash2 size={14} /></button>
                  </div>
                <button className="settings-link" onClick={() => setShowSettings(true)}>规则设置 <ChevronDown size={14} /></button>
              </div>

              <div className="section-heading movies-heading">
                <div><h2>全影院共享片库</h2><span className="section-count">{movies.length} 部影片 · 当前排入 {activeHall?.name || '-'}</span></div>
                <div className="library-heading-actions">
                  {movies.length > 5 && <label className="movie-filter"><Search size={14} /><input aria-label="筛选片库电影" value={movieSearch} onChange={(event) => setMovieSearch(event.target.value)} placeholder="筛选片名" /></label>}
                  <button className="text-action" onClick={() => openMovieEditor()}><Plus size={15} />录入电影</button>
                  <button className="text-action" onClick={() => { setShowLibrary(true); setQuery(''); }}><Film size={15} />管理片库</button>
                </div>
              </div>
              <div className="hall-switcher">
                <div className="hall-switcher-label"><span>当前影厅</span><strong>{activeHall?.name || '-'}</strong></div>
                <div className="hall-tabs">
                  {halls.map((hall) => <button key={hall.id} className={hall.id === activeHallId ? 'active' : ''} onClick={() => setActiveHallId(hall.id)}>{hall.name}<small>{(hallSchedules[hall.id] || []).length} 场</small></button>)}
                  <button className="hall-manage-button" onClick={() => setShowHallManager(true)} aria-label="管理影厅" title="管理影厅"><Settings2 size={15} /></button>
                </div>
              </div>
              <div className="movie-rail">
                {visibleMovies.map((movie) => {
                  const isSelected = selected.includes(movie.id);
                  return (
                    <article className={`movie-card ${isSelected ? 'chosen' : ''}`} key={movie.id}>
                      <button className="poster-button" onClick={() => addMovie(movie)} disabled={!canAddMovie(movie)} title={isSelected ? `移除${movie.title}` : canAddMovie(movie) ? `加入排片${movie.title}` : '营业时间已满'} aria-label={`${isSelected ? '移除' : '加入排片'}${movie.title}`}>
                        {hasLocalPoster(getPosterSrc(movie))
                          ? <img className="poster" src={getPosterSrc(movie)} alt={`${movie.title}封面`} />
                          : <div className="poster poster-fallback"><span>{movie.title}</span></div>}
                        <span className={`poster-status ${movie.status === '下映' ? 'ended' : ''}`}>{movie.status || '上映'}</span>
                        <span className={`poster-add ${isSelected ? 'added' : ''}`}>{isSelected ? <Check size={16} /> : <Plus size={17} />}</span>
                      </button>
                      <button className="movie-edit" title="编辑电影" aria-label={`编辑${movie.title}`} onClick={() => openMovieEditor(movie)}><Pencil size={13} /></button>
                      <div className="movie-title" title={movie.title}>{movie.title}</div>
                      <div className="movie-meta">{movie.runtime} 分钟</div>
                    </article>
                  );
                })}
                {movies.length > 0 && visibleMovies.length === 0 && <div className="movie-filter-empty">没有匹配的电影</div>}
                {!movies.length && <button className="movie-library-empty" onClick={() => openMovieEditor()}><span className="add-tile-icon"><Plus size={18} /></span><strong>添加第一部电影</strong><span>本地录入片名、时长和封面</span></button>}
              </div>

              <div className="schedule-header">
                <div className="section-heading"><div><h2>今日场次</h2><span className="section-count">{screenings.length ? `${screenings.length} 场` : '待生成'}</span></div></div>
                <div className="schedule-actions">
                  {(selected.length > 0 || screenings.length > 0) && <button className="clear-action" onClick={clearCurrentHall}><Trash2 size={14} />清空本厅</button>}
                  {Object.values(hallSchedules).some((schedule) => schedule.length > 0) && <button className="export-button" onClick={exportExcel}><Download size={15} />导出 Excel</button>}
                  {allScreenings.length > 0 && <button className="save-history-button" onClick={saveSchedule}><Archive size={15} />{editingHistoryId ? '更新历史' : '保存历史'}</button>}
                  <button className="generate-button" onClick={generateSchedule} disabled={!cinema.trim() || !selectedMovies.length}><Sparkles size={16} />自动排片</button>
                </div>
              </div>

              {!screenings.length ? (
                <div className="empty-schedule">
                  <div className="empty-graphic"><span className="empty-ring ring-one" /><span className="empty-ring ring-two" /><Clapperboard size={25} strokeWidth={1.5} /></div>
                  <div className="empty-title">{selectedMovies.length ? '准备好开始排片' : '先在本地片库录入电影'}</div>
                  <div className="empty-copy">{selectedMovies.length
                    ? `已选 ${selectedMovies.length} 部 · 共 ${selectedMovies.reduce((sum, movie) => sum + movie.runtime * (showCounts[movie.id] || 1), 0)} 分钟`
                    : '点选电影海报加入片单，再生成场次与保洁时间'}</div>
                  {selectedMovies.length > 0 && <div className="selected-chips">{selectedMovies.map((movie) => <span className="selected-chip" key={movie.id}><span>{movie.title}</span><span className="count-stepper"><button onClick={() => changeShowCount(movie.id, -1)} aria-label={`${movie.title}减少一场`}>−</button><b>{showCounts[movie.id] || 1} 场</b><button onClick={() => changeShowCount(movie.id, 1)} aria-label={`${movie.title}增加一场`}>+</button></span><button className="remove-chip" onClick={() => removeMovieFromSelection(movie.id)} aria-label={`移除${movie.title}`}><X size={12} /></button></span>)}</div>}
                  {!cinema.trim() && <span className="hint-line">先填写影院名称即可生成排片</span>}
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={({ active }) => setDraggingId(active.id)}
                  onDragCancel={() => setDraggingId(null)}
                  onDragEnd={handleDragEnd}
                >
                  <div className="timeline">
                    <div className="timeline-topline"><span>{cinema || '未命名影院'} · {activeHall?.name}</span><span>{date} · {screenings.length} 场</span></div>
                    <SortableContext items={screenings.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                      {screenings.map((item, index) => (
                        <SortableScreening
                          key={item.id}
                          item={item}
                          posterUrls={posterUrls}
                          index={index}
                          cleaning={cleaning}
                          dragging={draggingId === item.id}
                          onStartChange={updateStart}
                          onAddMovie={addMovieScreening}
                          onRemoveScreening={removeScreening}
                        />
                      ))}
                    </SortableContext>
                    <div className="timeline-footer"><span><Check size={14} />拖动左侧手柄调整顺序，时间自动重排</span></div>
                  </div>
                </DndContext>
              )}

              {screenings.length > 0 && <div className="summary-row"><span>总放映时长 <strong>{Math.floor(totalRuntime / 60)} 小时 {totalRuntime % 60} 分</strong></span><span>保洁时间 <strong>{screenings.length * cleaning} 分钟</strong></span><span>预计收场 <strong>{timeLabel(screenings[screenings.length - 1].cleaningEnd)}</strong></span></div>}
            </>
          ) : (
            <HistoryView history={history} posterUrls={posterUrls} onLoad={loadHistory} onDelete={setDeleteHistoryId} onPreview={setPreviewHistoryEntry} />
          )}
        </section>
      </main>

      {notice && <div className="save-notice" role="status"><Check size={15} />{notice}</div>}

      <nav className="mobile-tabs" aria-label="主导航">
        <button className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}><Clapperboard size={18} /><span>排片</span></button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={18} /><span>历史</span>{history.length > 0 && <i>{history.length}</i>}</button>
      </nav>

      {showSettings && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-head"><div><span className="modal-kicker">排片偏好</span><h2 id="settings-title">时间规则</h2></div><button className="icon-button" onClick={() => setShowSettings(false)} aria-label="关闭"><X size={18} /></button></div>
            <label className="form-row"><span><strong>每场保洁时间</strong><small>电影结束后预留的清洁时间</small></span><span className="number-control"><input type="number" min="0" max="60" step="5" value={cleaning} onChange={(event) => updateCleaning(event.target.value)} /><em>分钟</em></span></label>
            <label className="form-row"><span><strong>开场时间对齐</strong><small>下一场开始时间向上对齐</small></span><select value={rounding} onChange={(event) => updateRounding(event.target.value)}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option></select></label>
            <div className="rule-example"><Sparkles size={16} /><span>例如影片 11:08 结束，保洁 15 分钟后最早 11:23；按 {rounding} 分钟对齐，下一场安排在 <strong>{timeLabel(roundUp(11 * 60 + 8 + Number(cleaning), rounding))}</strong>。</span></div>
            <div className="data-tools">
              <button className="secondary-wide" onClick={createBackup}><Download size={14} />备份存档</button>
              <button className="secondary-wide" onClick={() => backupInputRef.current?.click()}><Upload size={14} />恢复存档</button>
            </div>
            <button className="reset-link" onClick={() => setShowReset(true)}><RotateCcw size={13} />重新开始排电影</button>
            <button className="primary-wide" onClick={() => setShowSettings(false)}>完成</button>
          </section>
        </div>
      )}

      {showLibrary && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLibrary(false); }}>
          <section className="modal search-modal movie-modal" role="dialog" aria-modal="true" aria-labelledby="library-title">
            <div className="modal-head"><div><span className="modal-kicker">仅保存在此设备</span><h2 id="library-title">我的片库</h2></div><button className="icon-button" onClick={() => setShowLibrary(false)} aria-label="关闭"><X size={18} /></button></div>
            <div className="library-tools"><label className="search-form"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找已录入的电影" /></label><button className="generate-button" onClick={() => openMovieEditor()}><Plus size={15} />录入电影</button></div>
            <div className="library-results">
              {filteredMovies.map((movie) => <div className="library-result" key={movie.id}>
                {hasLocalPoster(getPosterSrc(movie)) ? <img src={getPosterSrc(movie)} alt="" /> : <span className="result-placeholder"><span>{movie.title}</span></span>}
                <div className="library-result-info"><strong>{movie.title}</strong><span>{movie.runtime} 分钟</span></div>
                <button className="result-add" onClick={() => openMovieEditor(movie)} aria-label={`编辑${movie.title}`} title="编辑"><Pencil size={15} /></button>
                <button className="result-delete" onClick={() => deleteMovie(movie.id)} aria-label={`删除${movie.title}`} title="删除"><Trash2 size={15} /></button>
              </div>)}
              {!filteredMovies.length && <div className="no-results">{movies.length ? '没有找到这部电影' : '还没有录入电影'}</div>}
            </div>
          </section>
        </div>
      )}

      {showHallManager && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHallManager(false); }}>
          <section className="modal hall-modal" role="dialog" aria-modal="true" aria-labelledby="hall-title">
            <div className="modal-head"><div><span className="modal-kicker">影院空间</span><h2 id="hall-title">管理影厅</h2></div><button className="icon-button" onClick={() => setShowHallManager(false)} aria-label="关闭"><X size={18} /></button></div>
            <div className="hall-manager-list">
              {halls.map((hall, index) => <div className="hall-manager-row" key={hall.id}>
                <span className="hall-index">{pad(index + 1)}</span>
                <input value={hall.name} onChange={(event) => renameHall(hall.id, event.target.value)} aria-label={`${hall.name}名称`} />
                <select className="hall-start-select" value={hall.startTime || DEFAULT_START_TIME} onChange={(event) => updateHallStartTime(hall.id, event.target.value)} aria-label={`${hall.name}开始时间`}>
                  {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
                <span className="hall-manager-count">{(hallSchedules[hall.id] || []).length} 场</span>
                <button className="history-delete" onClick={() => deleteHall(hall.id)} disabled={halls.length <= 1} aria-label={`删除${hall.name}`} title={halls.length <= 1 ? '至少保留一个影厅' : '删除影厅'}><Trash2 size={15} /></button>
              </div>)}
            </div>
            <button className="secondary-wide" onClick={addHall}><Plus size={15} />添加影厅</button>
            <button className="primary-wide" onClick={() => setShowHallManager(false)}>完成</button>
          </section>
        </div>
      )}

      {showCinemaDialog && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCinemaDialog(false); }}>
          <section className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="cinema-dialog-title">
            <div className="modal-head"><div><span className="modal-kicker">影院工作区</span><h2 id="cinema-dialog-title">新增影院</h2></div><button className="icon-button" onClick={() => setShowCinemaDialog(false)} aria-label="关闭"><X size={18} /></button></div>
            <form onSubmit={confirmAddCinema}>
              <label className="editor-input"><span>影院名称</span><input autoFocus required maxLength="60" value={cinemaDraft} onChange={(event) => { setCinemaDraft(event.target.value); setCinemaDialogError(''); }} placeholder="输入影院名称" /></label>
              {cinemaDialogError && <span className="dialog-error">{cinemaDialogError}</span>}
              <div className="confirm-actions"><button type="button" className="secondary-wide" onClick={() => setShowCinemaDialog(false)}>取消</button><button type="submit" className="primary-wide">创建影院</button></div>
            </form>
          </section>
        </div>
      )}

      {editor && (
        <div className="modal-backdrop editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setEditor(null); setPosterError(''); } }}>
          <section className="modal editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
            <div className="modal-head"><div><span className="modal-kicker">本地片库</span><h2 id="editor-title">{editor.id ? '编辑电影' : '录入电影'}</h2></div><button className="icon-button" onClick={() => { setEditor(null); setPosterError(''); }} aria-label="关闭"><X size={18} /></button></div>
            <form onSubmit={saveMovie}>
              <div className="editor-fields">
                <label className="editor-input"><span>电影名称</span><input autoFocus required maxLength="60" value={editor.title} onChange={(event) => setEditor((current) => ({ ...current, title: event.target.value }))} placeholder="输入电影名称" /></label>
                <label className="editor-input"><span>电影时长</span><div className="runtime-input"><input required type="number" min="1" max="600" value={editor.runtime} onChange={(event) => setEditor((current) => ({ ...current, runtime: event.target.value }))} placeholder="例如 128" /><em>分钟</em></div></label>
              </div>
              <label className="editor-input status-input">
                <span>上映状态</span>
                <select value={editor.status || '上映'} onChange={(event) => setEditor((current) => ({ ...current, status: event.target.value }))}>
                  <option value="上映">上映</option>
                  <option value="下映">下映</option>
                </select>
              </label>
              <div className="poster-editor-row">
                <div className="poster-preview">{editor.poster ? <img src={editor.poster} alt="电影封面预览" /> : <div className="poster-name-preview"><Film size={19} /><span>{editor.title || '电影名称'}</span></div>}</div>
                <div className="poster-upload-copy"><strong>电影封面</strong><span>可选 · 图片会压缩后保存在本设备</span><label className="upload-button"><ImagePlus size={15} />{editor.poster ? '更换封面' : '选择图片'}<input type="file" accept="image/*" onChange={handlePosterChange} /></label>{posterError && <small className="poster-error">{posterError}</small>}</div>
                {editor.poster && <button type="button" className="remove-poster" onClick={() => setEditor((current) => ({ ...current, poster: '', posterBlob: null, posterId: '' }))} aria-label="移除封面"><X size={14} /></button>}
              </div>
              <button className="primary-wide" type="submit">{editor.id ? '保存修改' : '添加到片库'}</button>
            </form>
          </section>
        </div>
      )}

      {deleteHistoryId && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteHistoryId(null); }}>
          <section className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-history-title">
            <div className="modal-head"><div><span className="modal-kicker">历史记录</span><h2 id="delete-history-title">删除这份排片？</h2></div><button className="icon-button" onClick={() => setDeleteHistoryId(null)} aria-label="关闭"><X size={18} /></button></div>
            <p className="confirm-copy">删除后无法恢复，但不会影响片库和其他排片记录。</p>
            <div className="confirm-actions"><button className="secondary-wide" onClick={() => setDeleteHistoryId(null)}>取消</button><button className="danger-wide" onClick={() => { setHistory((current) => current.filter((entry) => entry.id !== deleteHistoryId)); setDeleteHistoryId(null); }}>删除记录</button></div>
          </section>
        </div>
      )}

      {showReset && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowReset(false); }}>
          <section className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <div className="modal-head"><div><span className="modal-kicker">本地数据</span><h2 id="reset-title">重新开始排电影？</h2></div><button className="icon-button" onClick={() => setShowReset(false)} aria-label="关闭"><X size={18} /></button></div>
            <p className="confirm-copy">会清空片库、影厅、当前排片和历史记录。这个操作无法撤销，建议先备份存档。</p>
            <div className="confirm-actions"><button className="secondary-wide" onClick={() => setShowReset(false)}>取消</button><button className="danger-wide" onClick={resetAll}>清空并重置</button></div>
          </section>
        </div>
      )}

      {previewHistoryEntry && (
        <HistoryPreview
          entry={previewHistoryEntry}
          onClose={() => setPreviewHistoryEntry(null)}
          onSaveImage={saveHistoryPreviewImage}
          posterUrls={posterUrls}
        />
      )}
    </div>
  );
}

function SortableScreening({
  item, index, cleaning, dragging, posterUrls, onStartChange, onAddMovie, onRemoveScreening,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined };
  const startValue = `${pad(Math.floor(item.start / 60) % 24)}:${pad(item.start % 60)}`;
  return (
    <div ref={setNodeRef} className={`timeline-row ${dragging ? 'drag-active' : ''}`} style={style}>
      <div className="time-column"><strong>{timeLabel(item.start)}</strong><span className="time-track"><i /></span></div>
      <div className="screening-block">
        <button className="drag-handle" {...attributes} {...listeners} aria-label={`拖动调整${item.movie.title}顺序`} title="拖动调整顺序"><GripVertical size={17} /></button>
        {hasLocalPoster(posterUrls[item.movie.posterId] || item.movie.poster)
          ? <img src={posterUrls[item.movie.posterId] || item.movie.poster} alt="" />
          : <div className="screening-poster-fallback">{item.movie.title}</div>}
        <div className="screening-info"><strong>{item.movie.title}</strong><span>{timeLabel(item.start)} – {timeLabel(item.end)} <i>·</i> {item.movie.runtime} 分钟</span></div>
        <label className="edit-time"><span>开场</span><input type="time" value={startValue} aria-label={`${item.movie.title}开始时间`} onChange={(event) => onStartChange(item.id, event.target.value)} /></label>
        <button
          type="button"
          className="add-screening"
          onClick={() => onAddMovie(item.movie.id)}
          aria-label={`再排一场${item.movie.title}`}
          title="再排一场"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="remove-screening"
          onClick={() => onRemoveScreening(item.id)}
          aria-label={`移除${item.movie.title}这一场`}
          title="移除这一场"
        >
          <X size={15} />
        </button>
      </div>
      {index >= 0 && <div className="cleaning-row"><span className="cleaning-dot" /><span>保洁</span><span>{timeLabel(item.end)} — {timeLabel(item.cleaningEnd)}</span><span className="cleaning-duration">{cleaning} 分钟</span></div>}
    </div>
  );
}

function HistoryView({ history, posterUrls, onLoad, onDelete, onPreview }) {
  const today = new Date();
  const initialHistoryDate = history[0]?.date ? new Date(`${history[0].date}T12:00:00`) : today;
  const [month, setMonth] = useState(new Date(initialHistoryDate.getFullYear(), initialHistoryDate.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(history[0]?.date || dateKey(today));
  const monthKey = `${month.getFullYear()}-${pad(month.getMonth() + 1)}`;
  const entriesByDate = history.reduce((result, entry) => {
    result[entry.date] = [...(result[entry.date] || []), entry];
    return result;
  }, {});
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const calendarCells = Array.from({ length: firstDay + daysInMonth }, (_, index) => {
    if (index < firstDay) return null;
    const day = index - firstDay + 1;
    return `${monthKey}-${pad(day)}`;
  });
  const selectedEntries = entriesByDate[selectedDate] || [];
  const selectedCinemaGroups = selectedEntries.reduce((result, entry) => {
    const key = entry.cinema || '未命名影院';
    result[key] = [...(result[key] || []), entry];
    return result;
  }, {});
  const orderedEntries = [...selectedEntries].sort((a, b) => (
    (a.cinema || '未命名影院').localeCompare(b.cinema || '未命名影院')
  ));

  function shiftMonth(amount) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  }

  return (
    <>
      <div className="page-heading history-heading"><div><div className="eyebrow"><span className="eyebrow-line" />存档</div><h1>每一次安排，都有迹可循。</h1><p className="heading-copy">点击有排片的日期，查看当天各影厅的安排。</p></div><span className="history-total">{history.length} 份计划</span></div>
      {!history.length ? (
        <div className="empty-history"><div className="empty-graphic"><span className="empty-ring ring-one" /><span className="empty-ring ring-two" /><History size={25} strokeWidth={1.5} /></div><strong>还没有保存过排片</strong><span>生成一份排片计划后，保存到这里方便以后查看。</span></div>
      ) : (
        <div className="history-calendar-layout">
          <section className="calendar-panel">
            <div className="calendar-toolbar">
              <button className="date-arrow" onClick={() => shiftMonth(-1)} aria-label="上个月"><ChevronLeft size={17} /></button>
              <strong>{month.getFullYear()} 年 {month.getMonth() + 1} 月</strong>
              <button className="date-arrow" onClick={() => shiftMonth(1)} aria-label="下个月"><ChevronRight size={17} /></button>
            </div>
            <div className="calendar-weekdays">{['日', '一', '二', '三', '四', '五', '六'].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="calendar-grid">
              {calendarCells.map((calendarDate, index) => {
                const dayEntries = calendarDate ? entriesByDate[calendarDate] || [] : [];
                const info = calendarDate ? calendarInfo(calendarDate) : { festival: '' };
                const isSelected = calendarDate === selectedDate;
                const isToday = calendarDate === dateKey(today);
                return <button key={calendarDate || `blank-${index}`} className={`calendar-day ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${dayEntries.length ? 'has-schedule' : ''}`} disabled={!calendarDate} onClick={() => calendarDate && setSelectedDate(calendarDate)}>
                  {calendarDate && <><span className="calendar-day-number">{Number(calendarDate.slice(-2))}</span>{info.festival && <small className="calendar-festival">{info.festival}</small>}{dayEntries.length > 0 && <i>{dayEntries.length}</i>}</>}
                </button>;
              })}
            </div>
            <div className="calendar-legend"><span><i className="legend-dot" />有排片</span><span><i className="legend-today" />今天</span></div>
          </section>
          <section className="calendar-detail">
            <div className="detail-heading"><div><span className="modal-kicker">当天排片</span><h2>{selectedDate.replaceAll('-', ' / ')}</h2></div><span>{Object.keys(selectedCinemaGroups).length} 家影院 · {selectedEntries.length} 份计划</span></div>
            {!selectedEntries.length ? <div className="detail-empty"><CalendarDays size={20} /><span>这一天还没有保存的排片</span></div> : <div className="day-history-list">{orderedEntries.map((entry, entryIndex) => {
              const entryHalls = entry.halls || [{ id: 'legacy', name: '1 号厅' }];
              const entrySchedules = entry.hallSchedules || { legacy: entry.screenings || [] };
              const allScreenings = Object.values(entrySchedules).flat();
              const firstScreening = allScreenings[0];
              const lastScreening = allScreenings[allScreenings.length - 1];
              const cinemaName = entry.cinema || '未命名影院';
              const previousCinema = orderedEntries[entryIndex - 1]?.cinema || '未命名影院';
              return <React.Fragment key={entry.id}>
                {cinemaName !== previousCinema && <div className="history-cinema-group-head"><strong>{cinemaName}</strong><span>{selectedCinemaGroups[cinemaName].length} 份计划</span></div>}
                <article className="day-history-card">
                <div className="day-history-card-head"><strong>{entry.cinema || '未命名影院'}</strong><div><button className="history-load" onClick={() => onPreview(entry)}><Eye size={14} />预览</button><button className="history-load" onClick={() => onLoad(entry)}>打开 <ChevronRight size={14} /></button><button className="history-delete" aria-label="删除计划" title="删除计划" onClick={() => onDelete(entry.id)}><Trash2 size={15} /></button></div></div>
                <div className="day-history-summary"><span><Clock3 size={13} />{firstScreening ? timeLabel(firstScreening.start) : '--:--'} <i>→</i> {lastScreening ? timeLabel(lastScreening.cleaningEnd) : '--:--'}</span><span>{allScreenings.length} 场 · {entryHalls.length} 个影厅</span></div>
                <div className="history-hall-tags">{entryHalls.map((hall) => <span key={hall.id}>{hall.name} <b>{(entrySchedules[hall.id] || []).length} 场</b></span>)}</div>
                <div className="history-posters">{allScreenings.slice(0, 8).map((item) => {
                  const poster = posterUrls[item.movie.posterId] || item.movie.poster;
                  return hasLocalPoster(poster) ? <img key={item.id} src={poster} alt={item.movie.title} title={item.movie.title} /> : <span key={item.id} title={item.movie.title}>{item.movie.title.slice(0, 2)}</span>;
                })}</div>
                </article>
              </React.Fragment>;
            })}</div>}
          </section>
        </div>
      )}
    </>
  );
}

function HistoryPreview({ entry, posterUrls, onClose, onSaveImage }) {
  const entryHalls = entry.halls || [{ id: 'legacy', name: '1 号厅' }];
  const entrySchedules = entry.hallSchedules || { legacy: entry.screenings || [] };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal history-preview-modal" role="dialog" aria-modal="true" aria-labelledby="history-preview-title">
        <div className="modal-head">
          <div><span className="modal-kicker">排片预览</span><h2 id="history-preview-title">{entry.cinema || '未命名影院'}</h2><p className="preview-date">{entry.date}</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="history-preview-scroll">
          <div className="history-preview-grid">
            {entryHalls.map((hall) => (
              <section className="history-preview-hall" key={hall.id}>
                <div className="history-preview-hall-head">{hall.name}</div>
                {(entrySchedules[hall.id] || []).map((item) => (
                  <article className="history-preview-screening" key={item.id}>
                    {hasLocalPoster(posterUrls[item.movie.posterId] || item.movie.poster)
                      ? <img src={posterUrls[item.movie.posterId] || item.movie.poster} alt="" />
                      : <div className="history-preview-poster">{item.movie.title}</div>}
                    <div><strong>{item.movie.title}</strong><span>{timeLabel(item.start)} - {timeLabel(item.end)}</span><small>{item.movie.runtime} 分钟</small></div>
                  </article>
                ))}
                {!entrySchedules[hall.id]?.length && <div className="history-preview-empty">暂无场次</div>}
              </section>
            ))}
          </div>
        </div>
        <div className="history-preview-actions">
          <button className="secondary-wide" onClick={onClose}>关闭</button>
          <button className="primary-wide" onClick={() => onSaveImage(entry)}><Download size={15} />保存图片</button>
        </div>
      </section>
    </div>
  );
}

export default App;
