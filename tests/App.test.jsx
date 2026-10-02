import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App.jsx';

const movies = [
  { id: 'movie-a', title: '电影 A', runtime: 90, poster: '', status: '上映' },
  { id: 'movie-b', title: '电影 B', runtime: 100, poster: '', status: '上映' },
];

function seedStorage(values = {}) {
  localStorage.clear();
  localStorage.setItem('ps-movies', JSON.stringify(values.movies || movies));
  localStorage.setItem('ps-cinema', values.cinema || '影院 A');
  Object.entries(values).forEach(([key, value]) => {
    if (key !== 'movies' && key !== 'cinema') localStorage.setItem(`ps-${key}`, JSON.stringify(value));
  });
}

function clickMovie(title) {
  fireEvent.click(screen.getByRole('button', { name: `加入排片${title}` }));
}

function generateSchedule() {
  fireEvent.click(screen.getByRole('button', { name: /自动排片/ }));
}

beforeEach(() => {
  seedStorage();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('排片回归测试', () => {
  it('新增影院时校验空名称和重复名称，并支持创建', async () => {
    seedStorage({ 'cinema-options': ['影院 A'], cinema: '影院 A' });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /新增影院/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '影院名称' }), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: /创建影院/ }));
    expect(await screen.findByText('请输入影院名称')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '影院名称' }), { target: { value: '影院 A' } });
    fireEvent.click(screen.getByRole('button', { name: /创建影院/ }));
    expect(await screen.findByText('该影院已经存在，请更换名称')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '影院名称' }), { target: { value: '影院 B' } });
    fireEvent.click(screen.getByRole('button', { name: /创建影院/ }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '当前影院' })).toHaveValue('影院 B'));
  });

  it('删除当前影院时只移除影院配置，不删除历史记录', () => {
    const history = [{
      id: 'history-a',
      cinema: '影院 A',
      date: '2026-10-01',
      halls: [{ id: 'hall-1', name: '1 号厅' }],
      hallSchedules: { 'hall-1': [] },
      screenings: [],
    }];
    seedStorage({ 'cinema-options': ['影院 A', '影院 B'], cinema: '影院 A', history });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '删除当前影院' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: '当前影院' })).toHaveValue('影院 B');
    expect(JSON.parse(localStorage.getItem('ps-cinema-options'))).toEqual(['影院 B']);
    expect(JSON.parse(localStorage.getItem('ps-history'))).toHaveLength(1);
  });

  it('同一电影排多场时，删除单场不会删除全部场次', async () => {
    render(<App />);

    clickMovie('电影 A');
    fireEvent.click(screen.getByRole('button', { name: '电影 A增加一场' }));
    generateSchedule();

    expect(document.querySelectorAll('.screening-info strong')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /移除电影 A这一场/ })[0]);

    await waitFor(() => expect(document.querySelectorAll('.screening-info strong')).toHaveLength(1));
    expect(document.querySelector('.schedule-header .section-count')).toHaveTextContent('1 场');
  });

  it('再次自动排片只追加新电影，不改变已有电影顺序', async () => {
    render(<App />);

    clickMovie('电影 A');
    generateSchedule();
    clickMovie('电影 B');
    generateSchedule();

    await waitFor(() => {
      const titles = [...document.querySelectorAll('.screening-info strong')].map((item) => item.textContent);
      expect(titles).toEqual(['电影 A', '电影 B']);
    });
  });

  it('同一日期的多个影院在历史中按影院分组展示', () => {
    const date = '2026-10-01';
    const entry = (id, cinema) => ({
      id,
      cinema,
      date,
      halls: [{ id: 'hall-1', name: '1 号厅' }],
      hallSchedules: { 'hall-1': [] },
      screenings: [],
    });
    seedStorage({
      history: [entry('history-b', '影院 B'), entry('history-a', '影院 A')],
    });
    render(<App />);

    fireEvent.click(screen.getAllByRole('button', { name: /历史/ })[0]);

    expect(screen.getByText('2 家影院 · 2 份计划')).toBeInTheDocument();
    expect(document.querySelectorAll('.history-cinema-group-head strong')).toHaveLength(2);
    expect(document.querySelector('.history-cinema-group-head strong')).toHaveTextContent('影院 A');
    expect(document.querySelectorAll('.history-cinema-group-head strong')[1]).toHaveTextContent('影院 B');
    expect(screen.getAllByText('1 份计划')).toHaveLength(2);
  });
});
