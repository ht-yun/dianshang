/**
 * ECharts 精简构建入口
 *
 * 全量包 1MB（gzip 后 330KB），但本项目只用到折线/柱状/饼图三个图表，
 * 以及 grid / tooltip / legend / title 四个组件。
 * 按需引入后体积约降到三分之一，首屏在窄带宽下快 2 秒以上。
 *
 * 构建：npm run build:echarts
 */
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  LabelLayout,
  CanvasRenderer,
]);

// 全站通过全局变量使用，保持与全量包一致
window.echarts = echarts;
