import './styles.css';
import { mountApp } from './app';

const root = document.querySelector<HTMLDivElement>('#app');

if (root) {
  mountApp(root);
}
