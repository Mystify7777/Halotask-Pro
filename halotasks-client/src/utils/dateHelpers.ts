export const formatDateForInput = (value?: string) => {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().split('T')[0];
};

export const getDateBadgeClass = (value?: string) => {
  if (!value) {
    return 'date-muted';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'date-muted';
  }

  const due = new Date(date.toDateString()).getTime();
  const today = new Date(new Date().toDateString()).getTime();

  if (due < today) {
    return 'date-overdue';
  }

  if (due === today) {
    return 'date-today';
  }

  return 'date-muted';
};
