/**
 * PageLayout 组件 - 简化版
 * 导航栏已提升到根布局（layout.tsx），此组件仅用于内容容器
 * 保留此组件是为了向后兼容，避免大量页面修改
 */

interface PageLayoutProps {
  children: React.ReactNode;
  activePath?: string; // 保留但已不使用，activePath 由导航栏组件自动检测
}

const PageLayout = ({ children }: PageLayoutProps) => {
  return (
    <>
      {children}
    </>
  );
};

export default PageLayout;
